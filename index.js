const fs = require("fs-extra");
const chalk = require("chalk");
const partialUtils = require("./utils/partials");
const helperUtils = require("./utils/helpers");
const Handlebars = require("handlebars");
const glob = require("glob");
const path = require("path");
const Logger = require("./utils/log");

/**
 * Returns the target filepath of a handlebars template
 * @param  {String} filePath            - input filepath
 * @param  {String} [outputTemplate]    - template for output filename.
 *                                          If ommited, the same filename stripped of its extension will be used
 * @return {String} target filepath
 */
function getTargetFilePath(filePath, outputTemplate) {
    if (outputTemplate == null) {
        return filePath.replace(path.extname(filePath), "");
    }

    const fileName = path.basename(filePath).replace(path.extname(filePath), "");

    if (typeof outputTemplate === "function") {
        return outputTemplate(fileName, filePath);
    }

    return outputTemplate.replace("[name]", fileName);
}

class HandlebarsPlugin {
    constructor(options) {
        this.options = Object.assign(
            {
                entry: null,
                output: null,
                data: {},
                helpers: {},
                htmlWebpackPlugin: null,
                log: false,
                onBeforeSetup: Function.prototype,
                onBeforeAddPartials: Function.prototype,
                onBeforeCompile: Function.prototype,
                onBeforeRender: Function.prototype,
                onBeforeSave: Function.prototype,
                onDone: Function.prototype
            },
            options
        );

        if (this.options.log) {
            Logger.enable();
        }

        // setup htmlWebpackPlugin default options and merge user configuration
        this.options.htmlWebpackPlugin = Object.assign({ enabled: false, prefix: "html" }, options.htmlWebpackPlugin);

        this.firstCompilation = true;
        this.options.onBeforeSetup(Handlebars);
        this.fileDependencies = [];
        this.assetsToEmit = {};
        this.updateData();
        this.prevTimestamps = {};
        this.startTime = Date.now();

        // register helpers
        const helperMap = helperUtils.resolve(this.options.helpers);
        helperMap.forEach((helper) => {
            helperUtils.register(Handlebars, helper.id, helper.helperFunction);
            this.addDependency(helper.filepath);
        });
    }

    /**
     * Register all partials to Handlebars
     */
    loadPartials() {
        // register partials
        const partials = partialUtils.resolve(Handlebars, this.options.partials);
        this.options.onBeforeAddPartials(Handlebars, partials);
        partialUtils.addMap(Handlebars, partials);
        // watch all partials for changes
        this.addDependency.apply(this, Object.keys(partials).map((key) => partials[key]));
    }

    /**
     * Webpack plugin hook - main entry point
     * @param  {Compiler} compiler
     */
    apply(compiler) {
        // COMPILE TEMPLATES
        const compile = (compilation, done) => {
            if (this.dependenciesUpdated(compilation) === false) {
                return done();
            }
            this.loadPartials(); // Refresh partials
            this.compileAllEntryFiles(compilation.compiler.outputPath, done); // build all html pages
            return undefined;
        };

        // REGISTER FILE DEPENDENCIES TO WEBPACK
        const emitDependencies = (compilation, done) => {
            // register dependencies at webpack
            if (compilation.fileDependencies.add) {
                // webpack@4
                this.fileDependencies.forEach(compilation.fileDependencies.add, compilation.fileDependencies);
            } else {
                compilation.fileDependencies = compilation.fileDependencies.concat(this.fileDependencies);
            }
            // emit generated html pages (webpack-dev-server)
            this.emitGeneratedFiles(compilation);
            return done();
        };

        if (compiler.hooks) {
            // @feature html-webpack-plugin
            if (this.options.htmlWebpackPlugin.enabled) {
                const { prefix } = this.options.htmlWebpackPlugin;

                compiler.hooks.compilation.tap("HtmlWebpackPluginHooks", (compilation) => {
                    compilation.hooks.htmlWebpackPluginAfterHtmlProcessing.tap("HandlebarsRenderPlugin", (data) => {
                        // @todo used a new partial helper to check for an existing partial
                        // @todo use generate id for consistent name replacements
                        const partialName = path.basename(data.outputName, ".hbs");
                        Handlebars.registerPartial(`${prefix}/${partialName}`, data.html);

                        try {
                            // @improve hacky filepath retrieval
                            // add source file to file dependencies, to watch for changes in webpack-dev-server
                            const sourceFile = data.plugin.options.template.split("!").pop();
                            this.fileDependencies.push(sourceFile);
                        } catch (e) {
                            Logger.log(chalk.red(e));
                        }

                        return data;
                    });
                });

                compiler.hooks.emit.tapAsync("HandlebarsRenderPlugin", (compilation, done) => {
                    compile(compilation, () => emitDependencies(compilation, done));
                });
            } else {
                // use standard compiler hooks
                compiler.hooks.make.tapAsync("HandlebarsRenderPlugin", compile);
                compiler.hooks.emit.tapAsync("HandlebarsRenderPlugin", emitDependencies);
            }
        } else {
            // @legacy wp < v4
            compiler.plugin("make", compile);
            compiler.plugin("emit", emitDependencies);
        }
    }

    /**
     * Returns contents of a dependent file
     * @param  {String} filepath
     * @return {String} filecontents
     */
    readFile(filepath) {
        this.fileDependencies.push(filepath);
        return fs.readFileSync(filepath, "utf-8");
    }

    /**
     * Registers a file as a dependency
     * @param {...[String]} args    - list of filepaths
     */
    addDependency(...args) {
        this.fileDependencies.push.apply(this.fileDependencies, args.filter((filename) => filename));
    }

    /**
     * @param  {Object} compilation     - webpack compilation
     * @return {Boolean} true, if a handlebars file or helper has been updated
     */
    dependenciesUpdated(compilation) {
        // NOTE: fileTimestamps will be an `object` or `Map` depending on the webpack version
        const fileTimestamps = compilation.fileTimestamps;
        const fileNames = fileTimestamps.has ? Array.from(fileTimestamps.keys()) : Object.keys(fileTimestamps);

        const changedFiles = fileNames.filter((watchfile) => {
            const prevTimestamp = this.prevTimestamps[watchfile];
            const nextTimestamp = fileTimestamps.has ? fileTimestamps.get(watchfile) : fileTimestamps[watchfile];
            this.prevTimestamps[watchfile] = nextTimestamp;
            return (prevTimestamp || this.startTime) < (nextTimestamp || Infinity);
        });

        // diff may be zero on initial build, thus also rebuild if there are no changes
        return changedFiles.length === 0 || this.containsOwnDependency(changedFiles);
    }

    /**
     * @param  {Array} list     - list of changed files as absolute paths
     * @return {Boolean} true, if a file is a dependency of this handlebars build
     */
    containsOwnDependency(list) {
        for (let i = 0; i < list.length; i += 1) {
            if (this.fileDependencies.includes(list[i])) {
                return true;
            }
        }
        return false;
    }

    /**
     * Register generated html files to support serving file with webpack-dev-server
     * @param  {String} filepath    - target filepath, where the file is created
     * @param  {String} content     - file contents
     */
    registerGeneratedFile(filepath, content) {
        this.assetsToEmit[path.basename(filepath)] = {
            source: () => content,
            size: () => content.length
        };
    }

    /**
     * Resets list of generated files
     */
    clearGeneratedFiles() {
        this.assetsToEmit = {};
    }

    /**
     * Notifies webpack-dev-server of generated files
     * @param  {Compilation} compilation
     */
    emitGeneratedFiles(compilation) {
        Object.keys(this.assetsToEmit).forEach((filename) => {
            compilation.assets[filename] = this.assetsToEmit[filename];
        });
    }

    /**
     * (Re)load input data for hbs rendering
     */
    updateData() {
        if (this.options.data && typeof this.options.data === "string") {
            this.data = {};
            const entryFilesArray = glob.sync(this.options.data);
            entryFilesArray.forEach((filePath) => {
                this.readDataFile(filePath);
            });
        } else {
            this.data = this.options.data;
        }
    }

    /**
     * Read a JSON file for input data
     * @param  {string} filePath    - path to the file
     */
    readDataFile(filePath) {
        try {
            const dataFromFile = JSON.parse(this.readFile(filePath));
            this.addDependency(filePath);
            const dataKey = path.basename(filePath, ".json");
            this.data[dataKey] = dataFromFile;
        } catch (e) {
            console.error(`Tried to read ${filePath} as json-file and failed. Using it as data source...`);
        }
    }

    /**
     * @async
     * Generates all given handlebars templates
     * @param  {String} outputPath  - webpack output path for build results
     * @param  {Function} done
     */
    compileAllEntryFiles(outputPath, done) {
        this.updateData();

        const entry = Array.isArray(this.options.entry) ? this.options.entry : [this.options.entry];
        Promise.all(
            entry.map((entryPattern) => new Promise((resolve, reject) => {
                glob(entryPattern, (err, entryFilesArray) => {
                    if (err) {
                        throw reject(err);
                    }
                    if (entryFilesArray.length === 0) {
                        log(chalk.yellow(`no valid entry files found for ${this.options.entry} -- aborting`));
                        return;
                    }
                    entryFilesArray.forEach((filepath) => this.compileEntryFile(filepath, outputPath));
                    // enforce new line after plugin has finished
                    console.log();

                    resolve();
                });
            }))
        ).then(() => done());
    }

    /**
     * Generates the html file for the given filepath
     * @param  {String} sourcePath  - filepath to handelebars template
     * @param  {String} outputPath  - webpack output path for build results
     */
    compileEntryFile(sourcePath, outputPath) {
        let targetFilepath = getTargetFilePath(sourcePath, this.options.output);
        // fetch template content
        let templateContent = this.readFile(sourcePath, "utf-8");
        templateContent = this.options.onBeforeCompile(Handlebars, templateContent) || templateContent;
        // create template
        const template = Handlebars.compile(templateContent);
        const data = this.options.onBeforeRender(Handlebars, this.data) || this.data;
        // compile template
        let result = template(data);
        result = this.options.onBeforeSave(Handlebars, result, targetFilepath) || result;

        if (targetFilepath.includes(outputPath)) {
            // change the destination path relative to webpacks output folder and emit it via webpack
            targetFilepath = targetFilepath.replace(outputPath, "").replace(/^\/*/, "");
            this.assetsToEmit[targetFilepath] = {
                source: () => result,
                size: () => result.length
            };
        } else {
            // @legacy: if the filepath lies outside the actual webpack destination folder, simply write that file.
            // There is no wds-support here, because of watched assets being emitted again
            fs.outputFileSync(targetFilepath, result, "utf-8");
        }

        this.options.onDone(Handlebars, targetFilepath);
        Logger.log(chalk.grey(`created output '${targetFilepath.replace(`${process.cwd()}/`, "")}'`));
    }
}

// export Handlebars for easy access in helpers
HandlebarsPlugin.Handlebars = Handlebars;

module.exports = HandlebarsPlugin;
