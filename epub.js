var xml2js = require('xml2js');
var xml2jsOptions = xml2js.defaults['0.1'];
var util = require('util');
var EventEmitter = require('events').EventEmitter;

try {
    // zipfile is an optional dependency:
    var ZipFile = require("zipfile").ZipFile;
} catch (err) {
    // Mock zipfile using pure-JS adm-zip:
    var AdmZip = require('adm-zip');
    
    var ZipFile = function(filename) {
        this.admZip = new AdmZip(filename);
        this.names = this.admZip.getEntries().map(function(zipEntry) {
            return zipEntry.entryName;
        });
        this.count = this.names.length;
    };
    ZipFile.prototype.readFile = function(name, cb) {
        this.admZip.readFileAsync(this.admZip.getEntry(name), function(buffer, error) {
            // `error` is bogus right now, so let's just drop it.
            // see https://github.com/cthackers/adm-zip/pull/88
            return cb(null, buffer);
        });
    };
}

//TODO: Cache parsed data

/**
 *  new EPub(fname[, imageroot][, linkroot])
 *  - fname (String): filename for the ebook
 *  - imageroot (String): URL prefix for images
 *  - linkroot (String): URL prefix for links
 *
 *  Creates an Event Emitter type object for parsing epub files
 *
 *      var epub = new EPub("book.epub");
 *      epub.on("end", function () {
 *           console.log(epub.spine);
 *      });
 *      epub.on("error", function (error) { ... });
 *      epub.parse();
 *
 *  Image and link URL format is:
 *
 *      imageroot + img_id + img_zip_path
 *
 *  So an image "logo.jpg" which resides in "OPT/" in the zip archive
 *  and is listed in the manifest with id "logo_img" will have the
 *  following url (providing that imageroot is "/images/"):
 *
 *      /images/logo_img/OPT/logo.jpg
 **/
function EPub(fname, imageroot, linkroot) {
    EventEmitter.call(this);
    this.filename = fname;

    this.imageroot = (imageroot || "/images/").trim();
    this.linkroot = (linkroot || "/links/").trim();

    if (this.imageroot.substr(-1) != "/") {
        this.imageroot += "/";
    }
    if (this.linkroot.substr(-1) != "/") {
        this.linkroot += "/";
    }
}
util.inherits(EPub, EventEmitter);

/**
 *  EPub#parse() -> undefined
 *
 *  Starts the parser, needs to be called by the script
 **/
EPub.prototype.parse = function () {

    this.containerFile = false;
    this.mimeFile = false;
    this.rootFile = false;

    this.metadata = {};
    this.manifest = {};
    this.spine    = {toc: false, contents: []};
    this.flow = [];
    this.toc = [];

    this._open();
};

/**
 *  EPub#_open() -> undefined
 *
 *  Opens the epub file with Zip unpacker, retrieves file listing
 *  and runs mime type check
 **/
EPub.prototype._open = function () {
    try {
        this.zip = new ZipFile(this.filename);
    } catch (E) {
        this.emit("error", new Error("Invalid/missing file"));
        return;
    }

    if (!this.zip.names || !this.zip.names.length) {
        this.emit("error", new Error("No files in archive"));
        return;
    }

    this._checkMimeType();
};

/**
 *  EPub#_checkMimeType() -> undefined
 *
 *  Checks if there's a file called "mimetype" and that it's contents
 *  are "application/epub+zip". On success runs root file check.
 **/
EPub.prototype._checkMimeType = function () {
    var i, len;

    for (i = 0, len = this.zip.names.length; i < len; i++) {
        if (this.zip.names[i].toLowerCase() == "mimetype") {
            this.mimeFile = this.zip.names[i];
            break;
        }
    }
    if (!this.mimeFile) {
        this.emit("error", new Error("No mimetype file in archive"));
        return;
    }
    this.zip.readFile(this.mimeFile, (function (err, data) {
        if (err) {
            this.emit("error", new Error("Reading archive failed"));
            return;
        }
        var txt = data.toString("utf-8").toLowerCase().trim();

        if (txt  !=  "application/epub+zip") {
            this.emit("error", new Error("Unsupported mime type"));
            return;
        }

        this._getRootFiles();
    }).bind(this));
};

/**
 *  EPub#_getRootFiles() -> undefined
 *
 *  Looks for a "meta-inf/container.xml" file and searches for a
 *  rootfile element with mime type "application/oebps-package+xml".
 *  On success calls the rootfile parser
 **/
EPub.prototype._getRootFiles = function () {
    var i, len;
    for (i = 0, len = this.zip.names.length; i < len; i++) {
        if (this.zip.names[i].toLowerCase() == "meta-inf/container.xml") {
            this.containerFile = this.zip.names[i];
            break;
        }
    }
    if (!this.containerFile) {
        this.emit("error", new Error("No container file in archive"));
        return;
    }

    this.zip.readFile(this.containerFile, (function (err, data) {
        if (err) {
            this.emit("error", new Error("Reading archive failed"));
            return;
        }
        var xml = data.toString("utf-8").toLowerCase().trim(),
            xmlparser = new xml2js.Parser(xml2jsOptions);

        xmlparser.on("end", (function (result) {

            if (!result.rootfiles || !result.rootfiles.rootfile) {
                this.emit("error", new Error("No rootfiles found"));
                console.dir(result);
                return;
            }

            var rootfile = result.rootfiles.rootfile,
                filename = false, i, len;

            if (Array.isArray(rootfile)) {

                for (i = 0, len = rootfile.length; i < len; i++) {
                    if (rootfile[i]["@"]["media-type"] &&
                            rootfile[i]["@"]["media-type"] == "application/oebps-package+xml" &&
                            rootfile[i]["@"]["full-path"]) {
                        filename = rootfile[i]["@"]["full-path"].toLowerCase().trim();
                        break;
                    }
                }

            } else if (rootfile["@"]) {
                if (rootfile["@"]["media-type"]  !=  "application/oebps-package+xml" || !rootfile["@"]["full-path"]) {
                    this.emit("error", new Error("Rootfile in unknown format"));
                    return;
                }
                filename = rootfile["@"]["full-path"].toLowerCase().trim();
            }

            if (!filename) {
                this.emit("error", new Error("Empty rootfile"));
                return;
            }


            for (i = 0, len = this.zip.names.length; i < len; i++) {
                if (this.zip.names[i].toLowerCase() == filename) {
                    this.rootFile = this.zip.names[i];
                    break;
                }
            }

            if (!this.rootFile) {
                this.emit("error", new Error("Rootfile not found from archive"));
                return;
            }

            this._handleRootFile();

        }).bind(this));

        xmlparser.on("error", (function (err) {
            this.emit("error", new Error("Parsing container XML failed"));
            return;
        }).bind(this));

        xmlparser.parseString(xml);


    }).bind(this));
};

/**
 *  EPub#_handleRootFile() -> undefined
 *
 *  Parses the rootfile XML and calls rootfile parser
 **/
EPub.prototype._handleRootFile = function () {

    this.zip.readFile(this.rootFile, (function (err, data) {
        if (err) {
            this.emit("error", new Error("Reading archive failed"));
            return;
        }
        var xml = data.toString("utf-8"),
            xmlparser = new xml2js.Parser(xml2jsOptions);

        xmlparser.on("end", this._parseRootFile.bind(this));

        xmlparser.on("error", (function (err) {
            this.emit("error", new Error("Parsing container XML failed"));
            return;
        }).bind(this));

        xmlparser.parseString(xml);

    }).bind(this));
};

/**
 *  EPub#_parseRootFile() -> undefined
 *
 *  Parses elements "metadata," "manifest," "spine" and TOC.
 *  Emits "end" if no TOC
 **/
EPub.prototype._parseRootFile = function (rootfile) {

    this.version = rootfile['@'].version || '2.0';

    var i, len, keys, keyparts, key;
    keys = Object.keys(rootfile);
    for (i = 0, len = keys.length; i < len; i++) {
        keyparts = keys[i].split(":");
        key = (keyparts.pop() || "").toLowerCase().trim();
        switch (key) {
        case "metadata":
            this._parseMetadata(rootfile[keys[i]]);
            break;
        case "manifest":
            this._parseManifest(rootfile[keys[i]]);
            break;
        case "spine":
            this._parseSpine(rootfile[keys[i]]);
            break;
        case "guide":
            //this.parseGuide(rootfile[keys[i]]);
            break;
        }
    }

    if (this.spine.toc) {
        this._parseTOC();
    } else {
        this.emit("end");
    }
};

/**
 *  EPub#_parseMetadata() -> undefined
 *
 *  Parses "metadata" block (book metadata, title, author etc.)
 **/
EPub.prototype._parseMetadata = function (metadata) {
    var myMetadata = this.metadata;

    Object.keys(metadata).forEach(function (key) {
        var keyparts = key.split(":");
        var name = (keyparts.pop() || "").toLowerCase().trim();
        var val = metadata[key];

        switch (name) {
        case "publisher":
        case "language":
        case "title":
        case "subject":
        case "description":
        case "date":
        case "creator":
            if (Array.isArray(val)) {
                myMetadata[name] = String(val[0] && val[0]["#"] || val[0] || "").trim();
            } else {
                myMetadata[name] = String(val["#"] || val || "").trim();
            }

            if (name == 'creator') {
                if (Array.isArray(val)) {
                    myMetadata.creatorFileAs = String(val[0] && val[0]['@'] && val[0]['@']["opf:file-as"] || myMetadata.creator).trim();
                } else {
                    myMetadata.creatorFileAs = String(val['@'] && val['@']["opf:file-as"] || myMetadata.creator).trim();
                }
            }
            break;
        case "identifier":
            if (val["@"] && val["@"]["opf:scheme"] == "ISBN") {
                myMetadata.ISBN = String(val["#"] || "").trim();
            } else if (val["@"] && val["@"].id && val["@"].id.match(/uuid/i)) {
                myMetadata.UUID = String(val["#"] || "").replace('urn:uuid:', '').toUpperCase().trim();
            } else if (Array.isArray(val)) {
                val.forEach(function(item) {
                    if (item["@"]) {
                        if (item["@"]["opf:scheme"] == "ISBN") {
                            myMetadata.ISBN = String(item["#"] || "").trim();
                        } else if (item["@"].id && item["@"].id.match(/uuid/i)) {
                            myMetadata.UUID = String(item["#"] || "").replace('urn:uuid:', '').toUpperCase().trim();
                        }
                    }
                });
            }
            break;
        }
    });
    
    var metas = metadata['meta'] || {};
    Object.keys(metas).forEach(function(key) {
        var meta = metas[key];
        if (meta['@'] && meta['@'].name) {
            var name = meta['@'].name;
            this.metadata[name] = meta['@'].content;
        }
        if (meta['#'] && meta['@'].property) {
            this.metadata[meta['@'].property] = meta['#'];
        }
    }, this);
};

/**
 *  EPub#_parseManifest() -> undefined
 *
 *  Parses "manifest" block (all items included, html files, images, styles)
 **/
EPub.prototype._parseManifest = function (manifest) {
    var i, len, path = this.rootFile.split("/"), element, path_str;
    path.pop();
    path_str = path.join("/");

    if (manifest.item) {
        for (i = 0, len = manifest.item.length; i < len; i++) {
            if (manifest.item[i]['@']) {
                element = manifest.item[i]['@'];

                if (element.href && element.href.substr(0, path_str.length)  !=  path_str) {
                    element.href = path.concat([element.href]).join("/");
                }

                this.manifest[manifest.item[i]['@'].id] = element;

            }
        }
    }
};

/**
 *  EPub#_parseSpine() -> undefined
 *
 *  Parses "spine" block (all html elements that are shown to the reader)
 **/
EPub.prototype._parseSpine = function (spine) {
    var i, len, path = this.rootFile.split("/"), element;
    path.pop();

    if (spine['@'] && spine['@'].toc) {
        this.spine.toc = this.manifest[spine['@'].toc] || false;
    }

    if (spine.itemref) {
        if(!Array.isArray(spine.itemref)){
            spine.itemref = [spine.itemref];
        }
        for (i = 0, len = spine.itemref.length; i < len; i++) {
            if (spine.itemref[i]['@']) {
                if (element = this.manifest[spine.itemref[i]['@'].idref]) {
                    this.spine.contents.push(element);
                }
            }
        }
    }
    this.flow = this.spine.contents;
};

/**
 *  EPub#_parseTOC() -> undefined
 *
 *  Parses ncx file for table of contents (title, html file)
 **/
EPub.prototype._parseTOC = function () {
    var i, len, path = this.spine.toc.href.split("/"), id_list = {}, keys;
    path.pop();

    keys = Object.keys(this.manifest);
    for (i = 0, len = keys.length; i < len; i++) {
        id_list[this.manifest[keys[i]].href] = keys[i];
    }

    this.zip.readFile(this.spine.toc.href, (function (err, data) {
        if (err) {
            this.emit("error", new Error("Reading archive failed"));
            return;
        }
        var xml = data.toString("utf-8"),
            xmlparser = new xml2js.Parser(xml2jsOptions);

        xmlparser.on("end", (function (result) {
            if (result.navMap && result.navMap.navPoint) {
                this.toc = this._walkNavMap(result.navMap.navPoint, path, id_list);
            }

            this.emit("end");
        }).bind(this));

        xmlparser.on("error", (function (err) {
            this.emit("error", new Error("Parsing container XML failed"));
            return;
        }).bind(this));

        xmlparser.parseString(xml);

    }).bind(this));
};

/**
 *  EPub#_walkNavMap(branch, path, id_list,[, level]) -> Array
 *  - branch (Array | Object): NCX NavPoint object
 *  - path (Array): Base path
 *  - id_list (Object): map of file paths and id values
 *  - level (Number): deepness
 *
 *  Walks the NavMap object through all levels and finds elements
 *  for TOC
 **/
EPub.prototype._walkNavMap = function (branch, path, id_list, level) {
    level = level || 0;

    // don't go too far
    if (level > 7) {
        return [];
    }

    var output = [];

    if (!Array.isArray(branch)) {
        branch = [branch];
    }

    for (var i = 0; i < branch.length; i++) {
        if (branch[i].navLabel) {

            var title = '';
            if (branch[i].navLabel && typeof branch[i].navLabel.text == 'string') {
                title = branch[i].navLabel.text.trim();
            }
            var order = Number(branch[i]["@"] && branch[i]["@"].playOrder || 0);
            if (isNaN(order)) {
                order = 0;
            }
            var href = '';
            if (branch[i].content && branch[i].content["@"] && typeof branch[i].content["@"].src == 'string') {
                href = branch[i].content["@"].src.trim();
            }

            var element = {
                level: level,
                order: order,
                title: title
            };

            if (href) {
                href = path.concat([href]).join("/");
                element.href = href;

                if (id_list[element.href]) {
                    // link existing object
                    element = this.manifest[id_list[element.href]];
                    element.title = title;
                    element.order = order;
                    element.level = level;
                } else {
                    // use new one
                    element.href = href;
                    element.id =  (branch[i]["@"] && branch[i]["@"].id || "").trim();
                }

                output.push(element);
            }
        }
        if (branch[i].navPoint) {
            output = output.concat(this._walkNavMap(branch[i].navPoint, path, id_list, level + 1));
        }
    }
    return output;
};

/**
 *  EPub#getChapter(id, callback) -> undefined
 *  - id (String): Manifest id value for a chapter
 *  - callback (Function): callback function
 *
 *  Finds a chapter text for an id. Replaces image and link URL's, removes
 *  <head> etc. elements. Return only chapters with mime type application/xhtml+xml
 **/
EPub.prototype.getChapter = function (id, callback) {
    this.getChapterRaw(id, (function (err, str) {
        if (err) {
            callback(err);
            return;
        }

        var i, len, path = this.rootFile.split("/"), keys = Object.keys(this.manifest);
        path.pop();

        // remove linebreaks (no multi line matches in JS regex!)
        str = str.replace(/\r?\n/g, "\u0000");

        // keep only <body> contents
        str.replace(/<body[^>]*?>(.*)<\/body[^>]*?>/i, function (o, d) {
            str = d.trim();
        });

        // remove <script> blocks if any
        str = str.replace(/<script[^>]*?>(.*?)<\/script[^>]*?>/ig, function (o, s) {
            return "";
        });

        // remove <style> blocks if any
        str = str.replace(/<style[^>]*?>(.*?)<\/style[^>]*?>/ig, function (o, s) {
            return "";
        });

        // remove onEvent handlers
        str = str.replace(/(\s)(on\w+)(\s*=\s*["']?[^"'\s>]*?["'\s>])/g, function (o, a, b, c) {
            return a + "skip-" + b + c;
        });

        // replace images
        str = str.replace(/(\ssrc\s*=\s*["']?)([^"'\s>]*?)(["'\s>])/g, (function (o, a, b, c) {
            var img = path.concat([b]).join("/").trim(),
                element;

            for (i = 0, len = keys.length; i < len; i++) {
                if (this.manifest[keys[i]].href == img) {
                    element = this.manifest[keys[i]];
                    break;
                }
            }

            // include only images from manifest
            if (element) {
                return a + this.imageroot + element.id + "/" + img + c;
            } else {
                return "";
            }

        }).bind(this));

        // replace links
        str = str.replace(/(\shref\s*=\s*["']?)([^"'\s>]*?)(["'\s>])/g, (function (o, a, b, c) {
            var linkparts = b && b.split("#"),
                link = path.concat([(linkparts.shift() || "")]).join("/").trim(),
                element;

            for (i = 0, len = keys.length; i < len; i++) {
                if (this.manifest[keys[i]].href.split("#")[0] == link) {
                    element = this.manifest[keys[i]];
                    break;
                }
            }

            if (linkparts.length) {
                link  +=  "#" + linkparts.join("#");
            }

            // include only images from manifest
            if (element) {
                return a + this.linkroot + element.id + "/" + link + c;
            } else {
                return a + b + c;
            }

        }).bind(this));

        // bring back linebreaks
        str = str.replace(/\u0000/g, "\n").trim();

        callback(null, str);
    }).bind(this));
};


/**
 *  EPub#getChapterRaw(id, callback) -> undefined
 *  - id (String): Manifest id value for a chapter
 *  - callback (Function): callback function
 *
 *  Returns the raw chapter text for an id.
 **/
EPub.prototype.getChapterRaw = function (id, callback) {
    if (this.manifest[id]) {

        if (!(this.manifest[id]['media-type'] == "application/xhtml+xml" || this.manifest[id]['media-type'] == "image/svg+xml")) {
            return callback(new Error("Invalid mime type for chapter"));
        }

        this.zip.readFile(this.manifest[id].href, (function (err, data) {
            if (err) {
                callback(new Error("Reading archive failed"));
                return;
            }

            var str = data.toString("utf-8");

            callback(null, str);

        }).bind(this));
    } else {
        callback(new Error("File not found"));
    }
};


/**
 *  EPub#getImage(id, callback) -> undefined
 *  - id (String): Manifest id value for an image
 *  - callback (Function): callback function
 *
 *  Finds an image for an id. Returns the image as Buffer. Callback gets
 *  an error object, image buffer and image content-type.
 *  Return only images with mime type image
 **/
EPub.prototype.getImage = function (id, callback) {
    if (this.manifest[id]) {

        if ((this.manifest[id]['media-type'] || "").toLowerCase().trim().substr(0, 6)  !=  "image/") {
            return callback(new Error("Invalid mime type for image"));
        }

        this.getFile(id, callback);
    } else {
        callback(new Error("File not found"));
    }
};


/**
 *  EPub#getFile(id, callback) -> undefined
 *  - id (String): Manifest id value for a file
 *  - callback (Function): callback function
 *
 *  Finds a file for an id. Returns the file as Buffer. Callback gets
 *  an error object, file contents buffer and file content-type.
 **/
EPub.prototype.getFile = function (id, callback) {
    if (this.manifest[id]) {

        this.zip.readFile(this.manifest[id].href, (function (err, data) {
            if (err) {
                callback(new Error("Reading archive failed"));
                return;
            }

            callback(null, data, this.manifest[id]['media-type']);
        }).bind(this));
    } else {
        callback(new Error("File not found"));
    }
};


EPub.prototype.readFile = function(filename, options, callback_) {
    var callback = arguments[arguments.length - 1];
    
    if (util.isFunction(options) || !options) {
        this.zip.readFile(filename, callback);
    } else if (util.isString(options)) {
        // options is an encoding
        this.zip.readFile(filename, function(err, data) {
            if (err) {
                callback(new Error('Reading archive failed'));
                return;
            }
            callback(null, data.toString(options));
        });
    } else {
        throw new TypeError('Bad arguments');
    }
};


// Expose to the world
module.exports = EPub;
