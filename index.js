const path = require('path');
const fs = require('fs-extra');
const postcss = require('postcss');
const cssModules = require('postcss-modules');
const util = require('util');
const tmp = require('tmp');
const crypto = require('crypto');
const hash = crypto.createHash('sha256');
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const ensureDir = util.promisify(fs.ensureDir);
const pluginNamespace = 'esbuild-css-modules-plugin-namespace';

const buildCssModulesJS = async (cssFullPath, options) => {
  const {
    localsConvention = 'camelCaseOnly',
    inject = true,
    generateScopedName,
    v2,
    bundle
  } = options;

  const css = await readFile(cssFullPath);

  let cssModulesJSON = {};
  const result = await postcss([
    cssModules({
      localsConvention,
      generateScopedName,
      getJSON(cssSourceFile, json) {
        cssModulesJSON = { ...json };
        return cssModulesJSON;
      }
    })
  ]).process(css, {
    from: undefined,
    map: false
  });

  const classNames = JSON.stringify(cssModulesJSON);
  hash.update(cssFullPath);
  const digest = hash.copy().digest('hex');

  let injectedCode = '';
  if (inject === true) {
    injectedCode = `
(function() {
  if (!document.getElementById(digest)) {
    var el = document.createElement('style');
    el.id = digest;
    el.textContent = css;
    document.head.appendChild(el);
  }
})();
    `;
  } else if (typeof inject === 'function') {
    injectedCode = inject(css, digest);
  }

  let jsContent = `
const digest = '${digest}';
const css = \`${result.css}\`;
${injectedCode}
export default ${classNames};
export { css, digest };
  `;

  if (bundle && v2) {
    jsContent = `
export default ${classNames};    
    `;
  }

  return {
    jsContent,
    cssContent: result.css
  };
};

const CssModulesPlugin = (options = {}) => {
  return {
    name: 'esbuild-css-modules-plugin',
    setup(build) {
      const rootDir = process.cwd();
      const tmpDirPath = tmp.dirSync().name;
      const { outdir, bundle } = build.initialOptions;
      const { v2 } = options;

      build.onResolve({ filter: /\.modules?\.css$/, namespace: 'file' }, async (args) => {
        const sourceFullPath = path.resolve(args.resolveDir, args.path);

        const sourceExt = path.extname(sourceFullPath);
        const sourceBaseName = path.basename(sourceFullPath, sourceExt);
        const sourceDir = path.dirname(sourceFullPath);
        const sourceRelDir = path.relative(path.dirname(rootDir), sourceDir);

        const tmpDir = path.resolve(tmpDirPath, sourceRelDir);
        await ensureDir(tmpDir);
        const tmpFilePath = path.resolve(tmpDir, `${sourceBaseName}.css`);

        const { jsContent: _jsContent, cssContent } = await buildCssModulesJS(sourceFullPath, {
          ...options,
          bundle
        });
        let jsContent = _jsContent;
        const tmpCss = path.resolve(
          sourceDir,
          `_tmp_${sourceBaseName}.css`.replace(/\.modules?\./, '.')
        );
        if (bundle && v2) {
          await writeFile(tmpCss, cssContent);
          jsContent =
            `import "${tmpCss}";
          ` + _jsContent;
        }

        await writeFile(`${tmpFilePath}.js`, jsContent);

        if (outdir && !bundle) {
          const isOutdirAbsolute = path.isAbsolute(outdir);
          const absoluteOutdir = isOutdirAbsolute ? outdir : path.resolve(args.resolveDir, outdir);
          const isEntryAbsolute = path.isAbsolute(args.path);
          const entryRelDir = isEntryAbsolute
            ? path.dirname(path.relative(args.resolveDir, args.path))
            : path.dirname(args.path);

          const targetSubpath =
            absoluteOutdir.indexOf(entryRelDir) === -1
              ? path.join(entryRelDir, `${sourceBaseName}.css.js`)
              : `${sourceBaseName}.css.js`;
          const target = path.resolve(absoluteOutdir, targetSubpath);

          fs.ensureDirSync(path.dirname(target));
          fs.copyFileSync(`${tmpFilePath}.js`, target);

          console.log(
            '[esbuild-css-modules-plugin]',
            path.relative(rootDir, sourceFullPath),
            '=>',
            path.relative(rootDir, target)
          );
        }

        if (!bundle) {
          return { path: sourceFullPath, namespace: 'file' };
        }

        return {
          path: `${tmpFilePath}.js`,
          namespace: pluginNamespace,
          pluginData: {
            content: jsContent,
            resolveArgs: {
              path: args.path,
              tmpCss,
              fullPath: sourceFullPath,
              importer: args.importer,
              namespace: args.namespace,
              resolveDir: args.resolveDir,
              kind: args.kind
            }
          }
        };
      });

      build.onLoad({ filter: /\.modules?\.css\.js$/, namespace: pluginNamespace }, (args) => {
        const {
          path: resolvePath,
          importer,
          fullPath,
          resolveDir,
          tmpCss
        } = args.pluginData.resolveArgs;
        const importerName = path.basename(importer);
        console.log(
          '[esbuild-css-modules-plugin]',
          `${resolvePath} => ${resolvePath}.js => ${importerName}`
        );
        if (tmpCss) {
          setTimeout(() => {
            try {
              fs.unlinkSync(tmpCss);
            } catch (e) {}
          }, 1000);
        }
        return {
          contents: args.pluginData.content,
          loader: 'js',
          watchFiles: [fullPath],
          resolveDir
        };
      });
    }
  };
};

module.exports = CssModulesPlugin;
