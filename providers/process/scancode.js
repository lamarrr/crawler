// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const AbstractProcessor = require('./abstractProcessor')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

class ScanCodeProcessor extends AbstractProcessor {
  constructor(options) {
    super(options)
    // Kick off version detection but don't wait. We'll wait before processing anything
    this._versionPromise = this._detectVersion()
  }

  get toolVersion() {
    return this._toolVersion
  }

  get toolName() {
    return 'scancode'
  }

  canHandle(request) {
    return request.type === 'scancode'
  }

  async handle(request) {
    if (!(await this._versionPromise)) return request.markSkip('ScanCode not found')
    super.handle(request)
    const file = this.createTempFile(request)
    await this._runScancode(request, file)
    const location = request.document.location
    const releaseDate = request.document.releaseDate
    request.document = this.clone(request.document)
    const metadata = request.document._metadata
    metadata.contentLocation = file.name
    metadata.contentType = 'application/json'
    metadata.releaseDate = releaseDate
    await this._attachInterestingFiles(request.document, file.name, location)
    return request
  }

  async _runScancode(request, file) {
    this.logger.info(
      `Analyzing ${request.toString()} using ScanCode. input: ${request.document.location} output: ${file.name}`
    )
    const { options, timeout, processes, format } = this.options
    const parameters = [...options, '--timeout', timeout.toString(), '-n', processes.toString(), format].join(' ')
    try {
      await promisify(exec)(
        `cd ${this.options.installDir} && .${path.sep}scancode ${parameters} ${file.name} ${request.document.location}`,
        { maxBuffer: 5000 * 1024 }
      )
    } catch (error) {
      // TODO see if the new version of ScanCode has a better way of differentiating errors
      if (this._isRealError(error) || this._hasRealErrors(file.name)) {
        request.markDead('Error', error ? error.message : 'ScanCode run failed')
        throw error
      }
    }
  }

  _attachInterestingFiles(document, outputFile, root) {
    const output = JSON.parse(fs.readFileSync(outputFile))
    // Pick files that are potentially whole licenses. We can be reasonably agressive here
    // and the summarizers etc will further refine what makes it into the final definitions
    const licenses = output.files.filter(file => file.is_license_text).map(file => file.path)
    this.attachFiles(document, licenses, root)

    // Pick files that represent whole packages. We can be reasonably agressive here
    // and the summarizers etc will further refine what makes it into the final definitions
    const packages = output.files.reduce((result, file) => {
      file.packages.forEach(entry => {
        // in this case the manifest_path contains a subpath pointing to the corresponding file
        if (file.type === 'directory' && entry.manifest_path)
          result.push(`${file.path ? file.path + '/' : ''}${entry.manifest_path}`)
        else result.push(file.path)
      })
      return result
    }, [])
    this.attachFiles(document, packages, root)
  }

  // Workaround until https://github.com/nexB/scancode-toolkit/issues/983 is resolved
  _isRealError(error) {
    return error && error.message && !error.message.includes('Some files failed to scan properly')
  }

  // Scan the results file for any errors that are not just timeouts or other known errors
  // TODO do we need to do this anymore
  _hasRealErrors(resultFile) {
    const results = JSON.parse(fs.readFileSync(resultFile))
    return results.files.some(
      file =>
        file.scan_errors &&
        file.scan_errors.some(error => {
          return !(
            error.includes('ERROR: Processing interrupted: timeout after') ||
            error.includes('ValueError:') ||
            error.includes('package.json')
          )
        })
    )
  }

  _detectVersion() {
    if (this._versionPromise) return this._versionPromise
    this._versionPromise = new Promise(resolve => {
      exec(`cd ${this.options.installDir} && .${path.sep}scancode --version`, 1024, (error, stdout) => {
        if (error) this.logger.log(`Could not detect version of ScanCode: ${error.message}`)
        this._toolVersion = stdout.replace('ScanCode version ', '').trim()
        this._schemaVersion = error
          ? null
          : this.aggregateVersions(
              [this._schemaVersion, this.toolVersion, this.configVersion],
              'Invalid ScanCode version'
            )
        resolve(this._schemaVersion)
      })
    })
    return this._versionPromise
  }
}

module.exports = options => new ScanCodeProcessor(options)
