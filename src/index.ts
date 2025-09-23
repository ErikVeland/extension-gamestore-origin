import * as Bluebird from 'bluebird';
import * as path from 'path';
import * as fs from 'fs-extra';

import { parseStringPromise } from 'xml2js';

import * as queryParser from 'querystring';

import turbowalk, { IEntry } from 'turbowalk';

import { log, types, util } from 'vortex-api';

const STORE_ID = 'origin';
const STORE_NAME = 'Origin';
const STORE_PRIORITY = 50;
const MANIFEST_EXT = '.mfst';

const INSTALLER_DATA = path.join('__Installer', 'installerdata.xml');
const ORIGIN_DATAPATH = 'c:\\ProgramData\\Origin\\';
const ORIGIN_MAC_DATAPATH = 'Library/Application Support/Origin';

export class MissingXMLElementError extends Error {
  private mElementName: string;
  constructor(elementName: string) {
    super('Missing XML element');
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.mElementName = elementName;
  }

  public get elementName() {
    return this.mElementName;
  }
}

// 3rd party game companies seem to generate their game
//  "DiP" manifest using a tool called EAInstaller, this
//  is the function we should be using _first_ when querying
//  the game's name as most games would be developed by non-EA
//  companies.
export declare type ManifestType = 'DiPManifest' | 'default';
class OriginLauncher implements types.IGameStore {
  public id: string = STORE_ID;
  public name: string = STORE_NAME;
  public priority: number = STORE_PRIORITY;
  private mClientPath: Promise<string>;
  private mCache: Promise<types.IGameStoreEntry[]>;

  constructor() {
    if (process.platform === 'win32') {
      // Windows implementation
      import('winapi-bindings').then((winapi) => {
        try {
          const clientPath = winapi.RegGetValue('HKEY_LOCAL_MACHINE',
            'SOFTWARE\\WOW6432Node\\Origin',
            'ClientPath');
          this.mClientPath = Promise.resolve(clientPath.value as string);
        } catch (err) {
          log('info', 'Origin launcher not found', { error: err.message });
          this.mClientPath = Promise.resolve(undefined);
        }
      }).catch((err) => {
        log('info', 'Origin launcher not found', { error: err.message });
        this.mClientPath = Promise.resolve(undefined);
      });
    } else if (process.platform === 'darwin') {
      // macOS implementation
      this.mClientPath = this.findMacOSOriginPath();
    } else {
      this.mClientPath = Promise.resolve(undefined);
    }
  }

  /**
   * Find Origin/EA App on macOS
   */
  private async findMacOSOriginPath(): Promise<string> {
    // Check standard installation paths
    const possiblePaths = [
      '/Applications/Origin.app',
      '/Applications/EADesktop.app',
      path.join(process.env.HOME || '', 'Applications', 'Origin.app'),
      path.join(process.env.HOME || '', 'Applications', 'EADesktop.app')
    ];

    for (const appPath of possiblePaths) {
      try {
        const stat = await fs.stat(appPath);
        if (stat.isDirectory()) {
          return Promise.resolve(appPath);
        }
      } catch (err) {
        // Continue to next path
      }
    }

    return Promise.reject(new Error('Origin/EA App not found on macOS'));
  }

  public launchGame(appId: string): Promise<void> {
    return this.getPosixPath(appId)
      .then(posPath => util.opn(posPath).catch(err => {
        log('debug', 'Origin game launch failed', err);
        return Promise.resolve();
      }));
  }

  public getPosixPath(name) {
    const posixPath = `origin2://game/launch?offerIds=${name}`;
    return Promise.resolve(posixPath);
  }

  public queryPath() {
    return this.mClientPath;
  }

  public isGameInstalled(name: string): Promise<boolean> {
    return this.findByName(name)
      .then(() => Promise.resolve(true))
      .catch(err => Promise.resolve(false));
  }

  public findByAppId(appId: string | string[]): Promise<types.IGameStoreEntry> {
    const matcher = Array.isArray(appId)
      ? (entry: types.IGameStoreEntry) => (appId.includes(entry.appid))
      : (entry: types.IGameStoreEntry) => (appId === entry.appid);

    return this.allGames()
      .then(entries => entries.find(matcher))
      .then(entry => entry === undefined
        ? Promise.reject(new types.GameEntryNotFound(Array.isArray(appId)
            ? appId.join(', ') : appId, STORE_ID))
        : Promise.resolve(entry));
  }

  public findByName(namePattern: string): Promise<types.IGameStoreEntry> {
    const re = new RegExp('^' + namePattern + '$');
    return this.allGames()
      .then(entries => entries.find(entry => re.test(entry.name)))
      .then(entry => entry === undefined
        ? Promise.reject(new types.GameEntryNotFound(namePattern, STORE_ID))
        : Promise.resolve(entry));
  }

  public getGameStorePath(): Promise<string> {
    return (!!this.mClientPath)
      ? this.mClientPath
      : Promise.resolve(undefined);
  }

  public allGames(): Promise<types.IGameStoreEntry[]> {
    if (!this.mCache) {
      this.mCache = this.parseLocalContent();
    }
    return this.mCache;
  }

  public reloadGames(): Promise<void> {
    return new Promise((resolve) => {
      this.mCache = this.parseLocalContent();
      return resolve();
    });
  }

  private async getGameName(installerPath: string, manifestType: ManifestType): Promise<string> {
    const installerData = await fs.readFile(installerPath, 'utf8')
    let xmlDoc;
    try {
      xmlDoc = await parseStringPromise(installerData);
    } catch (err) {
      return Promise.reject(err);
    }

    const elements = (manifestType === 'default')
      ? xmlDoc.game.metadata.localeInfo
      : xmlDoc.DiPManifest.gameTitles[0].gameTitle;
    for (const element of elements) {
      if (element.$.locale === 'en_US') {
        return (manifestType === 'default')
          ? Promise.resolve(element.title)
          : Promise.resolve(element._);
      }
    }
    return Promise.reject(new MissingXMLElementError('gameTitle(en_US)'));
  }

  private parseLocalContent(): Promise<types.IGameStoreEntry[]> {
    if (process.platform === 'darwin') {
      return this.parseLocalContentMacOS();
    } else {
      return this.parseLocalContentWindows();
    }
  }

  private parseLocalContentWindows(): Promise<types.IGameStoreEntry[]> {
    const localData = path.join(ORIGIN_DATAPATH, 'LocalContent');
    const allEntries: IEntry[] = [];
    return turbowalk(localData, entries => {
      allEntries.push(...entries);
    })
      .then(() => {
        // Each game can have multiple manifest files (DLC and stuff)
        //  but only 1 manifest inside each game folder will have the
        //  game's installation path.
        const manifests = allEntries.filter(manifest =>
          path.extname(manifest.filePath) === MANIFEST_EXT);

        return Bluebird.reduce(manifests, (accum: types.IGameStoreEntry[], manifest: IEntry) =>
          fs.readFile(manifest.filePath, { encoding: 'utf-8' })
            .then(data => {
              let query;
              try {
                // Ignore the preceding '?'
                query = queryParser.parse(data.substr(1));
              } catch (err) {
                log('error', 'failed to parse manifest file', err);
                return accum;
              }

              if (!!query.dipinstallpath && !!query.id) {
                // We have the installation path and the game's ID which we can
                //  use to launch the game, but we need the game's name as well.
                const gamePath = query.dipinstallpath as string;
                const appid = query.id as string;
                const installerFilepath = path.join(gamePath, INSTALLER_DATA);

                // Uninstalling Origin games does NOT remove manifest files, we need
                //  to ensure that the installer data file exists before we do anything.
                return fs.stat(installerFilepath).then(() =>
                  Bluebird.any([this.getGameName(installerFilepath, 'DiPManifest'),
                                this.getGameName(installerFilepath, 'default')]))
                  .then(name => {
                    // We found the name.
                    const launcherEntry: types.IGameStoreEntry = {
                      name, appid, gamePath, gameStoreId: STORE_ID,
                    };

                    accum.push(launcherEntry);
                    return accum;
                  })
                  .catch(err => {
                    if ((err.code === 'ENOENT')
                      && (err.message.indexOf(installerFilepath)) !== -1) {
                      // Game does not appear to be installed...
                      // tslint:disable-next-line: max-line-length
                      log('debug', 'Origin game manifest found, but does not appear to be installed', appid);
                      return accum;
                    }
                    const meta = Array.isArray(err)
                      ? err.map(errInst => errInst.message).join(';')
                      : err;

                    log('warn', 'failed to parse game name from manifest', meta);
                    return accum;
                  });
              } else {
                return Promise.resolve(accum);
              }
            })
            .catch(err => {
              log('warn', 'failed to parse manifest', err);
              return Promise.resolve(accum);
            }), []);
      })
      .catch(err => {
        log('warn', 'failed to read local content', err);
        return Promise.resolve([]);
      });
  }

  private async parseLocalContentMacOS(): Promise<types.IGameStoreEntry[]> {
    try {
      // On macOS, Origin/EA App stores data in ~/Library/Application Support/Origin
      const homeDir = process.env.HOME || '';
      const originDataPath = path.join(homeDir, ORIGIN_MAC_DATAPATH);
      
      // Check if Origin data directory exists
      try {
        await fs.stat(originDataPath);
      } catch (err) {
        // Origin data directory not found
        return [];
      }
      
      // Look for game information in LocalContent directory
      const localContentPath = path.join(originDataPath, 'LocalContent');
      let gameDirs: string[] = [];
      
      try {
        gameDirs = await fs.readdir(localContentPath);
      } catch (err) {
        // LocalContent directory not found
        return [];
      }
      
      const gameEntries: types.IGameStoreEntry[] = [];
      
      // Process each game directory
      for (const gameId of gameDirs) {
        try {
          const manifestPath = path.join(localContentPath, gameId, `*.${MANIFEST_EXT}`);
          // Find manifest files in the game directory
          const manifestFiles = await this.findManifestFiles(path.join(localContentPath, gameId));
          
          for (const manifestFile of manifestFiles) {
            try {
              const manifestData = await fs.readFile(manifestFile, 'utf8');
              // Parse manifest data (similar to Windows implementation)
              let query;
              try {
                // Ignore the preceding '?'
                query = queryParser.parse(manifestData.substr(1));
              } catch (err) {
                continue;
              }

              if (!!query.dipinstallpath && !!query.id) {
                const gamePath = query.dipinstallpath as string;
                const appid = query.id as string;
                const installerFilepath = path.join(gamePath, INSTALLER_DATA);

                // Verify the game is installed
                try {
                  await fs.stat(installerFilepath);
                  // Try to get the game name
                  try {
                    const name = await Bluebird.any([
                      this.getGameName(installerFilepath, 'DiPManifest'),
                      this.getGameName(installerFilepath, 'default')
                    ]);
                    
                    gameEntries.push({
                      name,
                      appid,
                      gamePath,
                      gameStoreId: STORE_ID,
                    });
                    break; // Found valid entry, move to next game
                  } catch (nameErr) {
                    // If we can't get the name, use a default
                    gameEntries.push({
                      name: `Origin Game ${appid}`,
                      appid,
                      gamePath,
                      gameStoreId: STORE_ID,
                    });
                    break; // Found valid entry, move to next game
                  }
                } catch (installErr) {
                  // Game not installed, continue to next manifest
                  continue;
                }
              }
            } catch (err) {
              // Failed to process manifest file
              log('debug', 'Failed to process Origin manifest file', { manifestFile, error: err.message });
            }
          }
        } catch (err) {
          // Failed to process game directory
          log('debug', 'Failed to process Origin game directory', { gameId, error: err.message });
        }
      }
      
      return gameEntries;
    } catch (err) {
      log('error', 'Failed to parse Origin local content on macOS', { error: err.message });
      return [];
    }
  }

  private async findManifestFiles(gameDir: string): Promise<string[]> {
    const manifestFiles: string[] = [];
    try {
      const files = await fs.readdir(gameDir);
      for (const file of files) {
        if (path.extname(file) === MANIFEST_EXT) {
          manifestFiles.push(path.join(gameDir, file));
        }
      }
    } catch (err) {
      // Failed to read directory
    }
    return manifestFiles;
  }
}

function main(context: types.IExtensionContext) {
  const instance: types.IGameStore = new OriginLauncher();

  if (instance !== undefined) {
    context.registerGameStore(instance);
  }

  return true;
}

export default main;