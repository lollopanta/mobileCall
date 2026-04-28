const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const { getMainActivityOrThrow } = AndroidConfig.Manifest;

module.exports = function withTabletResize(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const mainActivity = getMainActivityOrThrow(config.modResults);
    const application = manifest.application?.[0];

    mainActivity.$['android:resizeableActivity'] = 'true';
    delete mainActivity.$['android:screenOrientation'];

    if (application?.$) {
      application.$['android:resizeableActivity'] = 'true';
    }

    const supportsScreens = manifest['supports-screens']?.[0] ?? { $: {} };
    supportsScreens.$['android:anyDensity'] = 'true';
    supportsScreens.$['android:largeScreens'] = 'true';
    supportsScreens.$['android:xlargeScreens'] = 'true';
    supportsScreens.$['android:resizeable'] = 'true';
    manifest['supports-screens'] = [supportsScreens];

    return config;
  });
};
