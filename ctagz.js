/**
 *  Re-implementation of readtags.c in nodejs
 */

const Deque = require('double-ended-queue')
const minimatch = require('minimatch')
const path = require('path')
const Promise = require('bluebird')
const StringDecoder = require('string_decoder').StringDecoder
// StringDecoder lastTotal contains number of bytes remaining in buffer

const fs = Promise.promisifyAll(require('fs'))

const PSEUDO_TAG_PREFIX = '!_'

const TAG_UNSORTED = 0
const TAG_SORTED = 1
const TAG_FOLDSORTED = 2

function isdigit(d) {
    return d >= '0' && d <= '9'
}

class CTags {
    constructor(tagsFile, fd) {
        this.tagsFile = tagsFile
        this.fd = fd
        this.pos = 0
        this.workingPos = 0
        this.readBuffer = Buffer.allocUnsafe(1024)
        this.decoder = new StringDecoder()
        this.lines = new Deque()
        this.shouldSkip = false
        this.initialised = false

        this.info = {
            format: 1,
            sort: TAG_UNSORTED,
            author: '',
            name: '',
            url: '',
            version: ''
        }
    }

    _skipPartialUTF8(buffer, length) {
        let offset = 0
        while (offset < length && (buffer[offset] & 0xC0) === 0x80) {
            offset += 1
        }
        if (offset > 0) {
            return buffer.slice(offset)
        }
        return buffer
    }

    _parseExtensionFields(str, entry) {
        let pos = 0
        while (pos < str.length) {
            while (pos < str.length && str[pos] === '\t') {
                pos += 1
            }
            let splitPos = str.indexOf('\t', pos)
            if (splitPos < 0) {
                splitPos = str.length
            }
            let partPos = str.indexOf(':', pos)
            if (partPos < 0 || partPos > splitPos) {
                partPos = splitPos
            }

            if (partPos === splitPos) {
                entry.kind = str.substr(pos, splitPos - pos)
            } else {
                const key = str.substr(pos, partPos - pos)
                const value = str.substr(partPos + 1, splitPos - partPos - 1)
                if (key === 'kind') {
                    entry.kind = value
                } else if (key === 'file') {
                    entry.fileScope = true
                } else if (key === 'line') {
                    entry.address.lineNumber = parseInt(value, 10)
                } else {
                    entry.fields[key] = value
                }
            }
            pos = splitPos
        }
    }

    _parseTagLine(line) {
        const entry = {
            fields: {},
            kind: null,
            file: '',
            fileScope: false,
            name: '',
            address: {
                lineNumber: 0,
                pattern: ''
            },
            valid: false
        }

        const nameSplit = line.indexOf('\t')
        if (nameSplit < 0) {
            return entry
        }
        entry.name = line.substr(0, nameSplit)

        const fileSplit = line.indexOf('\t', nameSplit + 1)
        if (fileSplit < 0) {
            return entry
        }
        entry.file = line.substr(nameSplit + 1, fileSplit - nameSplit - 1)

        const pattern = line.substr(fileSplit + 1)
        let pos = 0
        if (pattern.length === 0) {
            return entry
        } else if (pattern[0] === '/' || pattern[0] === '?') {
            // We need to convert from a vim style regex to a normal/pcre regex
            // We'll assume ctags doesn't use anything fancy...
            const delimiter = pattern[0]
            let parsedPattern = ''
            pos += 1
            for (let bsc = 0; pos < pattern.length; pos += 1) {
                if (pattern[pos] === '\\') {
                    bsc += 1
                } else if (bsc > 0) {
                    parsedPattern += '\\'.repeat((bsc >>> 1))
                    parsedPattern += pattern[pos]
                    // if ((bsc & (bsc - 1)) === 0) {
                        // Escape!
                    // }
                    bsc = 0
                } else if (pattern[pos] === delimiter) {
                    break
                } else {
                    parsedPattern += pattern[pos]
                }
            }
            if (pos < pattern.length) {
                // We have a valid pattern
                entry.address.pattern = parsedPattern
                pos += 1
            } else {
                // It's invalid
                return entry
            }
        } else if (isdigit(pattern[0])) {
            entry.address.lineNumber = parseInt(pattern, 10)
            // entry.address.pattern = entry.address.lineNumber.toString()
            while (pos < pattern.length && isdigit(pattern[pos])) {
                pos += 1
            }
        } else {
            return entry
        }

        if (pattern.indexOf(';"', pos) === pos) {
            this._parseExtensionFields(pattern.substr(pos + 2), entry)
        }
        entry.valid = true
        return entry
    }

    _readTagLine() {
        const readAtLeastALine = Promise.method(() => {
            while (this.lines.length > 1) {
                const line = this.lines.shift()
                if (line) {
                    return line
                }
            }
            if (this.workingPos < this.size) {
                return fs.readAsync(this.fd, this.readBuffer, 0, this.readBuffer.length, this.workingPos)
                .then(bytesRead => {
                    this.workingPos += bytesRead
                    let readBuffer = this.readBuffer
                    if (this.shouldSkip) {
                        readBuffer = this._skipPartialUTF8(readBuffer, bytesRead)
                        this.shouldSkip = false
                    }

                    const parts = this.decoder.write(readBuffer).split(/\r?\n/)
                    // console.log(`Got ${parts.length} parts`)
                    if (this.lines.length > 0) {
                        this.lines.push(this.lines.pop() + parts[0])
                        this.lines.push(...parts.slice(1))
                    } else {
                        this.lines.push(...parts)
                    }

                    return readAtLeastALine()
                })
            } else if (this.lines.length > 0) {
                // Last line of file... probably
                return this.lines.shift()
            }
            return null
        })

        return readAtLeastALine()
    }

    _readTagLineSeek(pos) {
        this.pos = this.workingPos = Math.min(Math.max(pos, 0), this.size)
        this.decoder.end()
        this.lines.clear()
        this.shouldSkip = true

        return this._readTagLine().then(() => this._readTagLine())
    }

    _readPseudoTags() {
        const tagReader = () => this._readTagLine().then(l => {
            if (l && l.startsWith(PSEUDO_TAG_PREFIX)) {
                const entry = this._parseTagLine(l)
                switch (entry.name) {
                    case '!_TAG_FILE_SORTED':
                        this.info.sort = parseInt(entry.file, 10)
                        break
                    case '!_TAG_FILE_FORMAT':
                        this.info.format = parseInt(entry.file, 10)
                        break
                    case '!_TAG_PROGRAM_AUTHOR':
                        this.info.author = entry.file
                        break
                    case '!_TAG_PROGRAM_NAME':
                        this.info.name = entry.file
                        break
                    case '!_TAG_PROGRAM_URL':
                        this.info.url = entry.file
                        break
                    case '!_TAG_PROGRAM_VERSION':
                        this.info.version = entry.file
                        break
                    default:
                        break
                }
                return tagReader()
            }
            return this
        })

        return tagReader().finally(() => {
            this.workingPos = 0
            console.log(this.info)
        })
    }

    init() {
        let state
        if (!this.fd) {
            state = fs.openAsync(this.tagsFile).then(fd => {
                this.fd = fd
                return fs.fstatAsync(this.fd)
            })
        } else {
            state = fs.fstatAsync(this.fd)
        }

        return state.then(stats => {
            this.size = stats.size
        })
        .then(() => this._readPseudoTags())
        .then(() => {
            this.initialised = true
            return this
        })
    }

    destroy() {
        this.initialised = false
        if (this.fd) {
            return fs.closeAsync(this.fd).then(() => {
                this.fd = 0
            })
        }
        return Promise.resolve()
    }
}

/**
 *  Finds the CTags file from the specified search path and pattern
 *  @param [in] searchPath The path to search. This may either be a
 *                         file or directory. If a file is passed,
 *                         its directory is searched. If the tag file
 *                         is not found, its parent directories are
 *                         then searched.
 *  @param [in] tagFilePattern The search pattern to use when searching
 *                             for the tag file. This pattern can be
 *                             anything that the minimatch package
 *                             supports. However, if more than one file
 *                             matches, the results are sorted, and only
 *                             the first file is used as the tag file.
 *  @return An new CTags instance.
 *          The caller call destroy() when finished with it.
 */
function findCTagsFile(searchPath, tagFilePattern = '{.,}tags') {
    const ctagsFinder = function ctagsFinder(tagPath) {
        console.log(`Searching ${tagPath}`)
        return fs.readdirAsync(tagPath).then(files => {
            const matched = files.filter(minimatch.filter(tagFilePattern)).sort()
            const ret = !matched ? Promise.resolve(null) :
            Promise.reduce(matched, (acc, match) => {
                if (acc) {
                    return acc
                }
                const matchPath = path.join(tagPath, match)
                return fs.openAsync(matchPath, 'r').then(fd => new CTags(matchPath, fd))
                .catch(() => {}) // EAFP
            }, null)

            return ret.then(result => {
                const newTagPath = path.dirname(tagPath)
                if (!result && newTagPath !== tagPath) {
                    return ctagsFinder(newTagPath)
                }
                return result
            })
        })
    }

    let tagPath = path.resolve(searchPath)
    return fs.statAsync(tagPath).then(stats => {
        if (stats.isFile()) {
            tagPath = path.dirname(tagPath)
        }
        return ctagsFinder(tagPath)
    })
}


module.exports = { CTags, findCTagsFile }
