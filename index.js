const util = require('util');

(async () => {
    let plugin;
    let app;

    // Init
    try {
        app = require('./app');
        const opt = JSON.parse(process.argv[2]);
        plugin = require(opt.pluginapi + '/index.js')();
        plugin.log('IEC61850 plugin started.', 0);
    } catch (err) {
        const txt = 'Init error: ' + util.inspect(err);
        process.send({ type: 'debug', txt });
        process.exit(255);
    }

    // Params, logging, start app
    try {
        plugin.params.data = await plugin.params.get();
        plugin.log('plugin.params.get(): ' + util.inspect(plugin.params.data), 1);
        plugin.channels.data = await plugin.channels.get();
        plugin.log('plugin.channels.get(): ' + util.inspect(plugin.channels.data), 1);
        plugin.logger.setParams({logsize: 500, logrotate: 3});
        app(plugin, plugin.params.data); // Передаём params напрямую
    } catch (err) {
        plugin.exit(8, 'Error: ' + util.inspect(err));
    }
})();