import { OriginLauncher } from '../src/index';
import * as path from 'path';
import * as fs from 'fs-extra';
import { types } from 'vortex-api';

// Mock the vortex-api
jest.mock('vortex-api', () => ({
  log: jest.fn(),
  types: {
    IGameStore: jest.fn(),
    IGameStoreEntry: jest.fn(),
    GameEntryNotFound: jest.fn()
  }
}));

// Mock fs-extra
jest.mock('fs-extra', () => ({
  stat: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn()
}));

// Mock xml2js
jest.mock('xml2js', () => ({
  parseStringPromise: jest.fn()
}));

describe('OriginLauncher', () => {
  let originLauncher: OriginLauncher;
  
  beforeEach(() => {
    // Mock process.platform to test macOS functionality
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });
    
    // Reset mocks
    (fs.stat as jest.Mock).mockReset();
    (fs.readdir as jest.Mock).mockReset();
    (fs.readFile as jest.Mock).mockReset();
    
    originLauncher = new OriginLauncher();
  });
  
  describe('findMacOSOriginPath', () => {
    it('should find Origin in standard Applications directory', async () => {
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === '/Applications/Origin.app') {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      const result = await (originLauncher as any).findMacOSOriginPath();
      expect(result).toBe('/Applications/Origin.app');
    });
    
    it('should find EA Desktop app', async () => {
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === '/Applications/EADesktop.app') {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      const result = await (originLauncher as any).findMacOSOriginPath();
      expect(result).toBe('/Applications/EADesktop.app');
    });
    
    it('should reject if Origin/EA App is not found', async () => {
      (fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));
      
      await expect((originLauncher as any).findMacOSOriginPath()).rejects.toThrow('Origin/EA App not found on macOS');
    });
  });
  
  describe('parseLocalContentMacOS', () => {
    it('should return empty array if Origin data directory does not exist', async () => {
      (fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));
      
      const result = await (originLauncher as any).parseLocalContentMacOS();
      expect(result).toEqual([]);
    });
    
    it('should return game entries when games are found', async () => {
      // Mock the data directory exists
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('Library/Application Support/Origin')) {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock readdir to return game directories
      (fs.readdir as jest.Mock).mockResolvedValue(['game1', 'game2']);
      
      // Mock findManifestFiles to return manifest files
      (originLauncher as any).findManifestFiles = jest.fn().mockResolvedValue([
        '/Users/test/Library/Application Support/Origin/LocalContent/game1/manifest.mfst'
      ]);
      
      // Mock readFile to return manifest data
      (fs.readFile as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('manifest.mfst')) {
          return Promise.resolve('?dipinstallpath=/Games/Test%20Game&id=game1');
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock stat to verify installer data exists
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === '/Games/Test Game/__Installer/installerdata.xml') {
          return Promise.resolve({ isDirectory: () => true });
        } else if (filePath.includes('Library/Application Support/Origin')) {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock xml2js parser
      const { parseStringPromise } = require('xml2js');
      (parseStringPromise as jest.Mock).mockResolvedValue({
        game: {
          metadata: {
            localeInfo: [{
              $: { locale: 'en_US' },
              title: 'Test Game'
            }]
          }
        }
      });
      
      const result = await (originLauncher as any).parseLocalContentMacOS();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'Test Game',
        appid: 'game1',
        gamePath: '/Games/Test Game',
        gameStoreId: 'origin'
      });
    });
  });
});