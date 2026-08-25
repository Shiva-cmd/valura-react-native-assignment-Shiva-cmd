// The client core (../core/*.mjs) is the same pure module verified by
// verify-client.mjs at the repo root - the app imports it directly rather
// than duplicating its logic, so watchFolders has to reach outside this
// Expo project and sourceExts has to include .mjs.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs'];

module.exports = config;
