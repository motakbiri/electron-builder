import Ajv from "ajv"
import { CancellationToken } from "electron-builder-http"
import { asArray, debug, log, warn } from "electron-builder-util"
import { deepAssign } from "electron-builder-util/out/deepAssign"
import { statOrNull } from "electron-builder-util/out/fs"
import { httpExecutor } from "electron-builder-util/out/nodeHttpExecutor"
import { orNullIfFileNotExist } from "electron-builder-util/out/promise"
import { readJson } from "fs-extra-p"
import * as path from "path"
import { findAndReadConfig, readConfig } from "read-config-file"
import { Config } from "../metadata"
import { reactCra } from "../presets/rectCra"
import AdditionalPropertiesParams = ajv.AdditionalPropertiesParams
import ErrorObject = ajv.ErrorObject
import TypeParams = ajv.TypeParams

function getConfigFromPackageData(metadata: any | null) {
  return metadata == null ? null : metadata.build
}

async function loadConfig(projectDir: string, packageMetadata?: any): Promise<Config | null> {
  const data = getConfigFromPackageData(packageMetadata || (await orNullIfFileNotExist(readJson(path.join(projectDir, "package.json")))))
  return data == null ? findAndReadConfig<Config>(projectDir, "electron-builder", log) : data
}

/** @internal */
export async function getConfig(projectDir: string, configPath: string | null, packageMetadata: any | null, configFromOptions: Config | null | undefined): Promise<Config> {
  let fileOrPackageConfig
  if (configPath == null) {
    fileOrPackageConfig = await loadConfig(projectDir, packageMetadata)
  }
  else {
    fileOrPackageConfig = await readConfig<Config>(path.resolve(projectDir, configPath), projectDir, log)
  }

  const config: Config = deepAssign(fileOrPackageConfig == null ? Object.create(null) : fileOrPackageConfig, configFromOptions)

  let extendsSpec = config.extends
  if (extendsSpec == null && extendsSpec !== null && packageMetadata != null) {
    const devDependencies = packageMetadata.devDependencies
    if (devDependencies != null) {
      if ("react-scripts" in devDependencies) {
        extendsSpec = "react-cra"
        config.extends = extendsSpec
      }
      else if ("electron-webpack" in devDependencies) {
        extendsSpec = "electron-webpack/electron-builder.yml"
        config.extends = extendsSpec
      }
    }
  }

  if (extendsSpec == null) {
    return config
  }

  let parentConfig: Config | null
  if (extendsSpec === "react-cra") {
    parentConfig = await reactCra(projectDir)
  }
  else {
    let spec = extendsSpec
    let isFileSpec: boolean | undefined
    if (spec.startsWith("file:")) {
      spec = spec.substring("file:".length)
      isFileSpec = true
    }

    parentConfig = await orNullIfFileNotExist(readConfig(path.resolve(projectDir, spec), projectDir, log))
    if (parentConfig == null && isFileSpec !== true) {
      let resolved: string | null = null
      try {
        resolved = require.resolve(spec)
      }
      catch (e) {
        // ignore
      }

      if (resolved != null) {
        parentConfig = await readConfig(resolved, projectDir, log)
      }
    }

    if (parentConfig == null) {
      throw new Error(`Cannot find parent config file: ${spec}`)
    }
  }

  // electron-webpack and electrify client config - want to exclude some files
  // we add client files configuration to main parent file matcher
  if (parentConfig.files != null && config.files != null && (Array.isArray(config.files) || typeof config.files === "string") && Array.isArray(parentConfig.files) && parentConfig.files.length > 0) {
    const mainFileSet = parentConfig.files[0]
    if (typeof mainFileSet === "object" && (mainFileSet.from == null || mainFileSet.from === ".")) {
      mainFileSet.filter = asArray(mainFileSet.filter)
      mainFileSet.filter.push(...asArray(config.files as any))
      delete (config as any).files
    }
  }

  return deepAssign(parentConfig, config)
}

/** @internal */
export async function getElectronVersion(projectDir: string, config?: Config, projectMetadata?: any | null): Promise<string> {
  if (config == null) {
    config = await getConfig(projectDir, null, null, null)
  }
  if (config.electronVersion != null) {
    return config.electronVersion
  }
  return await computeElectronVersion(projectDir, projectMetadata)
}

/** @internal */
export async function computeElectronVersion(projectDir: string, projectMetadata?: any | null): Promise<string> {
  // projectMetadata passed only for prepacked app asar and in this case no dev deps in the app.asar
  if (projectMetadata == null) {
    for (const name of ["electron", "electron-prebuilt", "electron-prebuilt-compile"]) {
      try {
        return (await readJson(path.join(projectDir, "node_modules", name, "package.json"))).version
      }
      catch (e) {
        if (e.code !== "ENOENT") {
          warn(`Cannot read electron version from ${name} package.json: ${e.message}`)
        }
      }
    }
  }

  const packageJsonPath = path.join(projectDir, "package.json")
  const electronPrebuiltDep = findFromElectronPrebuilt(projectMetadata || await readJson(packageJsonPath))
  if (electronPrebuiltDep == null || electronPrebuiltDep === "latest") {
    try {
      const releaseInfo = await httpExecutor.request<any>({
        hostname: "github.com",
        path: "/electron/electron/releases/latest",
        headers: {
          Accept: "application/json",
        },
      }, new CancellationToken())
      return (releaseInfo.tag_name.startsWith("v")) ? releaseInfo.tag_name.substring(1) : releaseInfo.tag_name
    }
    catch (e) {
      warn(e)
    }

    throw new Error(`Cannot find electron dependency to get electron version in the '${packageJsonPath}'`)
  }

  const firstChar = electronPrebuiltDep[0]
  return firstChar === "^" || firstChar === "~" ? electronPrebuiltDep.substring(1) : electronPrebuiltDep
}

function findFromElectronPrebuilt(packageData: any): any {
  for (const name of ["electron", "electron-prebuilt", "electron-prebuilt-compile"]) {
    const devDependencies = packageData.devDependencies
    let dep = devDependencies == null ? null : devDependencies[name]
    if (dep == null) {
      const dependencies = packageData.dependencies
      dep = dependencies == null ? null : dependencies[name]
    }
    if (dep != null) {
      return dep
    }
  }
  return null
}

let validatorPromise: Promise<any> | null = null

async function createConfigValidator() {
  const ajv = new Ajv({allErrors: true, coerceTypes: true})
  ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-04.json"))
  require("ajv-keywords")(ajv, ["typeof"])
  const schema = await readJson(path.join(__dirname, "..", "..", "scheme.json"))
  return ajv.compile(schema)
}

/** @internal */
export async function validateConfig(config: Config) {
  const extraMetadata = config.extraMetadata
  if (extraMetadata != null) {
    if (extraMetadata.build != null) {
      throw new Error(`--em.build is deprecated, please specify as -c"`)
    }
    if (extraMetadata.directories != null) {
      throw new Error(`--em.directories is deprecated, please specify as -c.directories"`)
    }
  }

  // noinspection JSDeprecatedSymbols
  if (config.npmSkipBuildFromSource === false) {
    config.buildDependenciesFromSource = false
  }

  if (validatorPromise == null) {
    validatorPromise = createConfigValidator()
  }

  const validator = await validatorPromise
  if (!validator(config)) {
    debug(JSON.stringify(validator.errors, null, 2))
    throw new Error(`Config is invalid:
${JSON.stringify(normaliseErrorMessages(validator.errors!), null, 2)}

How to fix:
  1. Open https://github.com/electron-userland/electron-builder/wiki/Options
  2. Search the option name on the page.
    * Not found? The option was deprecated or not exists (check spelling).
    * Found? Check that the option in the appropriate place. e.g. "title" only in the "dmg", not in the root.
`)
  }
}

function normaliseErrorMessages(errors: Array<ErrorObject>) {
  const result: any = Object.create(null)
  for (const e of errors) {
    if (e.keyword === "type" && (e.params as TypeParams).type === "null") {
      // ignore - no sense to report that type accepts null
      continue
    }

    const dataPath = e.dataPath.length === 0 ? [] : e.dataPath.substring(1).split(".")
    if (e.keyword === "additionalProperties") {
      dataPath.push((e.params as AdditionalPropertiesParams).additionalProperty)
    }

    let o = result
    let lastName: string | null = null
    for (const p of dataPath) {
      if (p === dataPath[dataPath.length - 1]) {
        lastName = p
        break
      }
      else {
        if (o[p] == null) {
          o[p] = Object.create(null)
        }
        else if (typeof o[p] === "string") {
          o[p] = [o[p]]
        }
        o = o[p]
      }
    }

    if (lastName == null) {
      lastName = "unknown"
    }

    let message = e.message!.toUpperCase()[0] + e.message!.substring(1)
    switch (e.keyword) {
      case "additionalProperties":
        message = "Unknown option"
        break

      case "required":
        message = "Required option"
        break

      case "anyOf":
        message = "Invalid option object"
        break
    }

    if (o[lastName] != null && !Array.isArray(o[lastName])) {
      o[lastName] = [o[lastName]]
    }

    if (Array.isArray(o[lastName])) {
      o[lastName].push(message)
    }
    else {
      o[lastName] = message
    }
  }
  return result
}

const DEFAULT_APP_DIR_NAMES = ["app", "www"]

/** @internal */
export async function computeDefaultAppDirectory(projectDir: string, userAppDir: string | null | undefined): Promise<string> {
  if (userAppDir != null) {
    const absolutePath = path.resolve(projectDir, userAppDir)
    const stat = await statOrNull(absolutePath)
    if (stat == null) {
      throw new Error(`Application directory ${userAppDir} doesn't exists`)
    }
    else if (!stat.isDirectory()) {
      throw new Error(`Application directory ${userAppDir} is not a directory`)
    }
    else if (projectDir === absolutePath) {
      warn(`Specified application directory "${userAppDir}" equals to project dir — superfluous or wrong configuration`)
    }
    return absolutePath
  }

  for (const dir of DEFAULT_APP_DIR_NAMES) {
    const absolutePath = path.join(projectDir, dir)
    const packageJson = path.join(absolutePath, "package.json")
    const stat = await statOrNull(packageJson)
    if (stat != null && stat.isFile()) {
      return absolutePath
    }
  }
  return projectDir
}