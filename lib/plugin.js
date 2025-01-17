const path = require('path');
const { createHash } = require('crypto');
const { readFile, writeFile, unlink, appendFile } = require('fs/promises');
const {
  getLogger,
  buildInjectCode,
  pluginName,
  getRootDir,
  pluginNamespace,
  buildingCssSuffix,
  builtCssSuffix,
  getModulesCssRegExp,
  getBuiltModulesCssRegExp,
  getRelativePath,
  getBuildId,
  validateNamedExport,
  getPackageVersion
} = require('./utils.js');
const cssHandler = require('lightningcss');
const camelCase = require('lodash/camelCase');
const upperFirst = require('lodash/upperFirst');
const kebabCase = require('lodash/kebabCase');
const BuildCache = require('./cache.js');

/**
 * buildCssModulesJs
 * @param {{fullPath: string; options: import('..').Options; digest: string; build: import('..').Build}} params
 * @returns {Promise<{resolveDir: string; js: string; css: string; originCss: string; exports: Record<string, string>}>}
 */
const buildCssModulesJs = async ({ fullPath, options, build }) => {
  const cssFileName = path.basename(fullPath); // e.g. xxx.module.css?esbuild-css-modules-plugin-building
  const { buildId, relative, packageVersion, log } = build.context;
  const resolveDir = path.dirname(fullPath);
  const classPrefix =
    path.basename(fullPath, path.extname(fullPath)).replace(/[^a-zA-Z0-9]/g, '-') + '__';
  const versionString = packageVersion?.replace(/[^a-zA-Z0-9]/g, '') ?? '';
  const originCss = await readFile(fullPath);
  const cssModulesOption = options.v2CssModulesOption || {};
  const genTs = !!options.generateTsFile;

  /**
   * @type {import('lightningcss').BundleOptions}
   */
  const bundleConfig = {
    filename: relative(fullPath), // use relative path to keep hash stable in different machines
    code: originCss,
    minify: false,
    sourceMap: true,
    cssModules: {
      pattern: `${classPrefix}[local]_[hash]${versionString}`,
      ...cssModulesOption
    },
    analyzeDependencies: false
  };
  const { code, exports = {}, map } = cssHandler.transform(bundleConfig);
  let cssModulesContent = code.toString('utf-8');

  const cssModulesJSON = {};

  Object.keys(exports)
    .sort() // to keep order consistent in different builds
    .forEach((originClass) => {
      const patchedClass = exports[originClass].name;

      cssModulesJSON[originClass] = patchedClass;
    });
  
  const classNamesMapString = `{\n${
    Object.entries(cssModulesJSON)
      .map(([name, val]) => [kebabCase(name), val])
      .map(([name, val]) => `${name.includes('-') ? `'${name}'` : name}: '${val}'`)
  }\n}`;

  let cssWithSourceMap = cssModulesContent;
  if (map) {
    cssWithSourceMap += `\n/*# sourceMappingURL=data:application/json;base64,${map.toString(
      'base64'
    )} */`;
  }

  // fix path issue on Windows: https://github.com/indooorsman/esbuild-css-modules-plugin/issues/12
  const cssImportPath =
    './' +
    cssFileName.split(path.sep).join(path.posix.sep).trim().replace(buildingCssSuffix, '') +
    builtCssSuffix;
  // => ./xxx.module.css?esbuild-css-modules-plugin-built
  const importStatement = `import "${cssImportPath}";`;

  const exportStatement = options.inject
    ? `
export default new Proxy(${classNamesMapString}, {
  get: function(source, key) {
    setTimeout(() => {
      window.__inject_${buildId}__ && window.__inject_${buildId}__();
    }, 0);
    return source[key];
  }
});
  `
    : `export default ${classNamesMapString};`;

  const namedExportsTs = [];
  const namedExportStatements = Object.entries(cssModulesJSON)
    .map(([ccn, className]) => {
      const camelCaseClassName = camelCase(ccn)
      if (!validateNamedExport(camelCaseClassName)) {
        throw new Error(
          `the class name "${camelCaseClassName}" in file ${fullPath} is a reserved keyword in javascript, please change it to someother word to avoid potential errors`
        );
      }
      const line = `export const ${camelCaseClassName} = "${className}"`;
      genTs && namedExportsTs.push(`${line} as const;`);
      return `${line};`;
    })
    .join('\n');

  const js = `${importStatement}\n${exportStatement};\n${namedExportStatements}`;

  if (genTs) {
    let ts = `export default ${classNamesMapString} as const;\n${namedExportsTs.join('\n')}\n`.replaceAll('"', "'");
    const tsPath = `${fullPath.replace(/\?.+$/, '')}.ts`;
    log(tsPath, ts);
    if(canUsePrettier()) {
      const prettier = require("prettier")
      const config = await prettier.resolveConfig("./", { editorconfig: true })
      ts = prettier.format(ts, Object.assign({}, config, { parser: "typescript" }))
    }
    await writeFile(tsPath, ts, { encoding: 'utf-8' });
  }

  return {
    js,
    css: cssWithSourceMap,
    originCss: originCss.toString('utf8'),
    exports,
    resolveDir
  };
};

/**
 * prepareBuild
 * @param {import('..').Build} build
 * @param {import('..').Options} options
 * @return {Promise<void>}
 */
const prepareBuild = async (build, options) => {
  const buildId = await getBuildId(build);
  const packageVersion = getPackageVersion(build);
  build.initialOptions.metafile = true;
  const packageRoot = options.root;
  const buildRoot = getRootDir(build);
  const log = getLogger(build);
  const relative = (to) => getRelativePath(build, to);

  build.context = {
    buildId,
    buildRoot,
    packageRoot,
    packageVersion,
    log,
    relative
  };
  build.context.cache = new BuildCache(build);

  log(`root of this build(#${buildId}):`, buildRoot);
};

/**
 * onResolveModulesCss
 * @description mark module(s).css as sideEffects and add namespace
 * @param {import('esbuild').OnResolveArgs} args
 * @param {import('..').Build} build
 * @returns {Promise<import('esbuild').OnResolveResult>}
 */
const onResolveModulesCss = async (args, build) => {
  const { resolve, initialOptions, context } = build;
  const { resolveDir, path: p, pluginData = {}, kind } = args;
  const { log, relative } = context;
  const { path: absPath } = await resolve(typeof p === "string" ? p : p.in, { resolveDir, kind });
  const rpath = relative(absPath);
  log('resolve', p, 'to', rpath, 'from build root');

  /**
   * @type {import('esbuild').OnResolveResult}
   */
  const result = {
    namespace: pluginNamespace,
    suffix: buildingCssSuffix,
    path: rpath,
    external: false,
    pluginData: {
      ...pluginData,
      relativePathToBuildRoot: rpath
    },
    sideEffects: true,
    pluginName
  };

  result.watchFiles = [absPath];

  return result;
};

/**
 * onLoadModulesCss
 * @param {import('..').Build} build
 * @param {import('..').Options} options
 * @param {import('esbuild').OnLoadArgs} args
 * @return {(import('esbuild').OnLoadResult | null | undefined | Promise<import('esbuild').OnLoadResult | null | undefined>)}
 */
const onLoadModulesCss = async (build, options, args) => {
  const { path: maybeFullPath, pluginData = {} } = args;
  const { buildRoot, log, cache } = build.context;
  const absPath = path.isAbsolute(maybeFullPath)
    ? maybeFullPath
    : path.resolve(buildRoot, maybeFullPath);
  const rpath = pluginData.relativePathToBuildRoot;

  log(`loading ${rpath}${args.suffix}`);

  const useCache = build.initialOptions.watch ?? options.watch ?? false;

  useCache && log(`checking cache for`, rpath);
  const cached = useCache && (await cache.get(absPath));
  if (cached) {
    log('return build cache for', rpath);
    return cached;
  }

  const hex = createHash('sha256').update(rpath).digest('hex');
  const digest = hex.slice(hex.length - 255, hex.length);

  const { js, ts, resolveDir, css, exports, originCss } = await buildCssModulesJs({
    fullPath: absPath,
    options,
    digest,
    build
  });

  const result = {
    pluginName,
    resolveDir,
    pluginData: {
      ...pluginData,
      css,
      exports,
      digest
    },
    contents: js,
    loader: 'js'
  };

  if (useCache) {
    await cache.set(absPath, result, originCss);
    log(`add build result to cache for ${rpath}`);
  }

  return result;
};

/**
 * onResolveBuiltModulesCss
 * @param {import('esbuild').OnResolveArgs} args
 * @param {import('..').Build} build
 * @returns {Promise<import('esbuild').OnResolveResult>}
 */
const onResolveBuiltModulesCss = async (args, build) => {
  const { path: p, pluginData = {} } = args;
  const { relativePathToBuildRoot } = pluginData;

  build.context?.log(`resolve virtual path ${p} to ${relativePathToBuildRoot}${builtCssSuffix}`);

  /**
   * @type {import('esbuild').OnResolveResult}
   */
  const result = {
    namespace: pluginNamespace,
    path: relativePathToBuildRoot + builtCssSuffix,
    external: false,
    pluginData,
    sideEffects: true,
    pluginName
  };

  return result;
};

/**
 * onLoadBuiltModulesCss
 * @param {import('esbuild').OnLoadArgs} args
 * @param {import('..').Build} build
 * @returns {Promise<import('esbuild').OnLoadResult>}
 */
const onLoadBuiltModulesCss = async ({ pluginData }, build) => {
  const { log, buildRoot } = build.context;
  const { css, relativePathToBuildRoot } = pluginData;
  const absPath = path.resolve(buildRoot, relativePathToBuildRoot);
  const resolveDir = path.dirname(absPath);
  log('loading built css for', relativePathToBuildRoot);

  /**
   * @type {import('esbuild').OnLoadResult}
   */
  const result = {
    contents: css,
    loader: 'css',
    pluginName,
    resolveDir,
    pluginData
  };

  return result;
};

/**
 * onEnd
 * @param {import('..').Build} build
 * @param {import('..').Options} options
 * @param {import('esbuild').BuildResult} result
 */
const onEnd = async (build, options, result) => {
  const { initialOptions, context, esbuild } = build;
  const { buildId, buildRoot } = context;
  const log = getLogger(build);

  if (options.inject) {
    const {
      charset = 'utf8',
      outdir,
      sourceRoot,
      sourcemap,
      sourcesContent,
      entryPoints,
      minify,
      logLevel,
      format,
      target,
      external,
      publicPath
    } = initialOptions;
    const absOutdir = path.isAbsolute(outdir) ? outdir : path.resolve(buildRoot, outdir);

    const transformCss = async (css) => {
      const r = await esbuild.transform(css, {
        charset,
        loader: 'css',
        sourcemap: false,
        minify: true,
        logLevel,
        format,
        target
      });
      return r.code;
    };

    const buildJs = async (entryName, entryPath, jsCode) => {
      const r = (p) => path.relative(absOutdir, p).split(path.sep).join(path.posix.sep);
      const imports = `import "./${r(entryPath)}";\nexport * from "./${r(entryPath)}";`;
      if (sourcemap === 'external') {
        await appendFile(entryPath, `\n//# sourceMappingURL=${r(entryPath)}.map`, {
          encoding: 'utf8'
        });
      } else if (publicPath && sourcemap) {
        const fixedPublicPath = publicPath.endsWith('/') ? publicPath : publicPath + '/';
        const entryContent = await readFile(entryPath, { encoding: 'utf8' });
        await writeFile(
          entryPath,
          entryContent.replace(`sourceMappingURL=${fixedPublicPath}`, 'sourceMappingURL='),
          { encoding: 'utf8' }
        );
      }
      const tmpJsCode = `${imports}\n${jsCode}`;
      const tmpJsPath = path.resolve(absOutdir, '.build.inject.js');
      await writeFile(tmpJsPath, tmpJsCode, { encoding: 'utf8' });
      await esbuild.build({
        charset,
        absWorkingDir: absOutdir,
        write: true,
        allowOverwrite: true,
        treeShaking: false,
        logLevel,
        format,
        target,
        minify,
        sourceRoot,
        publicPath,
        sourcemap,
        sourcesContent,
        entryPoints: {
          [entryName]: tmpJsPath
        },
        outdir: absOutdir,
        bundle: true,
        external
      });
      await unlink(tmpJsPath);
    };

    const cssContents = [];

    let entriesArray = [];
    if (Array.isArray(entryPoints)) {
      entriesArray = [...entryPoints];
    } else {
      Object.keys(entryPoints)
        .sort()
        .forEach((k) => {
          entriesArray.push(entryPoints[k]);
        });
    }
    const entries = entriesArray.map((p) => (path.isAbsolute(typeof p === "string" ? p : p.in) ? typeof p === "string" ? p : p.in : path.resolve(buildRoot, typeof p === "string" ? p : p.in)));

    log('entries:', entries);

    let entryToInject = null;
    const outputs = Object.keys(result.metafile?.outputs ?? []);

    await Promise.all(
      outputs.map(async (f) => {
        if (
          !entryToInject &&
          result.metafile.outputs[f].entryPoint &&
          entries.includes(path.resolve(buildRoot, result.metafile.outputs[f].entryPoint)) &&
          ['.js', '.mjs', '.cjs'].includes(path.extname(f))
        ) {
          entryToInject = path.resolve(buildRoot, f);
        }
        if (path.extname(f) === '.css') {
          const fullpath = path.resolve(buildRoot, f);
          const css = await readFile(fullpath, { encoding: 'utf8' });
          const transformed = await transformCss(css);
          cssContents.push(`${transformed}`);
        }
      })
    );

    if (entryToInject && cssContents.length) {
      log('inject css to', path.relative(buildRoot, entryToInject));
      const entryName = path.basename(entryToInject, path.extname(entryToInject));
      const allCss = cssContents.join('\n');
      const container = typeof options.inject === 'string' ? options.inject : 'head';
      const injectedCode = buildInjectCode(container, allCss, buildId, options);
      await buildJs(entryName, entryToInject, injectedCode);
    }
  }

  log('finished');
};

/**
 * setup
 * @param {import('..').Build} build
 * @param {import('..').Options} options
 * @returns {Promise<void>}
 */
const setup = async (build, options) => {
  await prepareBuild(build, options);
  const modulesCssRegExp = getModulesCssRegExp(options);
  const builtModulesCssRegExp = getBuiltModulesCssRegExp(options);

  // resolve xxx.module.css to xxx.module.css?esbuild-css-modules-plugin-building
  build.onResolve({ filter: modulesCssRegExp, namespace: 'file' }, (args) => {
    return onResolveModulesCss(args, build);
  });

  // load xxx.module.css?esbuild-css-modules-plugin-building
  build.onLoad({ filter: modulesCssRegExp, namespace: pluginNamespace }, (args) => {
    return onLoadModulesCss(build, options, args);
  });

  // resolve virtual path xxx.module.css?esbuild-css-modules-plugin-built
  build.onResolve(
    {
      filter: builtModulesCssRegExp,
      namespace: pluginNamespace
    },
    (args) => {
      return onResolveBuiltModulesCss(args, build);
    }
  );

  // load virtual path xxx.module.css?esbuild-css-modules-plugin-built
  build.onLoad(
    {
      filter: builtModulesCssRegExp,
      namespace: pluginNamespace
    },
    (args) => {
      return onLoadBuiltModulesCss(args, build);
    }
  );

  build.onEnd(async (result) => {
    onEnd(build, options, result);
  });
};

let isPrettierInstalled;
const canUsePrettier = () => {
  if(isPrettierInstalled === undefined) {
    try {
      require.resolve("prettier")
      isPrettierInstalled = true;
    } catch(e) {
      isPrettierInstalled = false;
    }
  }

  return isPrettierInstalled;
}

module.exports = {
  setup
};
