/**
 * Local Expo config plugin for AgentKey's Android manifest needs.
 *
 * Three things app.json cannot express on its own:
 *
 * 1. `android:usesCleartextTraffic="true"` -- 9router and most self-hosted
 *    OpenAI-compatible routers are plain http:// on a LAN address. Android 9+
 *    blocks cleartext by default, so without this every request fails with
 *    "Cleartext HTTP traffic to 192.168.x.x not permitted".
 *
 * 2. A `<queries>` block for Termux. Under Android 11+ package visibility, an
 *    app cannot even see that another package exists unless it declares it.
 *    Without this the "is Termux installed?" check always returns false.
 *
 * 3. The `com.termux.permission.RUN_COMMAND` permission, needed by the optional
 *    native shell bridge described in the README. Declaring it is harmless when
 *    Termux is absent.
 */

const { withAndroidManifest } = require('expo/config-plugins');

const TERMUX_PACKAGES = ['com.termux', 'com.termux.api'];
const RUN_COMMAND_PERMISSION = 'com.termux.permission.RUN_COMMAND';

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withAgentKeyAndroid = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // 1. Cleartext HTTP for LAN endpoints.
    const application = manifest.application?.[0];
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true';
    }

    // 2. Package visibility for the Termux availability check.
    if (!Array.isArray(manifest.queries)) manifest.queries = [];
    if (manifest.queries.length === 0) manifest.queries.push({});
    const queries = manifest.queries[0];
    if (!Array.isArray(queries.package)) queries.package = [];
    for (const name of TERMUX_PACKAGES) {
      const already = queries.package.some((p) => p?.$?.['android:name'] === name);
      if (!already) queries.package.push({ $: { 'android:name': name } });
    }

    // 3. Permission used only by the optional native shell bridge.
    if (!Array.isArray(manifest['uses-permission'])) manifest['uses-permission'] = [];
    const hasPermission = manifest['uses-permission'].some(
      (p) => p?.$?.['android:name'] === RUN_COMMAND_PERMISSION
    );
    if (!hasPermission) {
      manifest['uses-permission'].push({ $: { 'android:name': RUN_COMMAND_PERMISSION } });
    }

    return cfg;
  });

module.exports = withAgentKeyAndroid;
