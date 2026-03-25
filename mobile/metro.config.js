const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");
const path = require("path");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

module.exports = withNativewind(config, {
  // Explicit absolute path fixes the pnpm deep-nesting path bug on Windows
  input: path.resolve(__dirname, "src/global.css"),
  // inline variables break PlatformColor in CSS variables
  inlineVariables: false,
  // We add className support manually
  globalClassNamePolyfill: false,
});