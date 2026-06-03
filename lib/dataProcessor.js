// dataProcessor.js
const { getNested } = require('./utils');
const { getNodeChannelMap, getDirectChannelMap } = require('./mappings');

// Helper to send data
function sendChannelData(plugin, channelsData, ts) {
    const dataArray = channelsData.map(({ id, value, chstatus = 0 }) => ({ id, value, ts, chstatus }));
    plugin.sendData(dataArray);
    // plugin.log(`Sent ${dataArray.length} channel values`); // Removed log
}

// Process DataSet/report values (object-based)
function processDataSetValues(plugin, dataSetRef, result, reasons = null, ts) {
    const map = getNodeChannelMap().get(dataSetRef);
    if (!map) {
        // plugin.log(`No map for DataSet ${dataSetRef}`); // Removed log
        return;
    }

    // plugin.log(`Raw DataSet result: isValid=${result.isValid}, error=${result.errorReason || 'none'}, keys=${Object.keys(result.values || {}).length}`); // Removed log

    if (!result.isValid) {
        const channelsData = map.channels.map(ch => ({ id: ch.id, value: null, chstatus: 2 }));
        sendChannelData(plugin, channelsData, ts);
        // plugin.log(`DataSet ${dataSetRef} invalid (count: ${result.count})`); // Removed log
        return;
    }

    const channelsData = [];
    let includedCount = 0;
    const totalReasons = reasons ? Object.keys(reasons).length : 0;

    map.channels.forEach(ch => {
        if (reasons && (reasons[ch.fullRef] === undefined || reasons[ch.fullRef] === 0)) {
            return; // Skip unchanged
        }

        const valObj = result.values[ch.fullRef];
        let value = null;
        let chstatus = 0;
        if (valObj) {
            value = getNested(valObj, ch.valuePath);
            if (valObj.q > 0 || valObj.t > 0) {
                chstatus = 1;
                // plugin.log(`Quality issue for ${ch.id}: q=${valObj.q}, t=${valObj.t}`); // Removed log
            }
            if (value === undefined || value === null) {
                chstatus = 1;
                // plugin.log(`Path ${ch.valuePath} not found in ${ch.fullRef}`); // Removed log
            }
            includedCount++;
        } else {
            chstatus = 2;
            // plugin.log(`${ch.fullRef} missing in ${dataSetRef}`); // Removed log
        }
        channelsData.push({ id: ch.id, value, chstatus });
    });

    if (channelsData.length > 0) {
        sendChannelData(plugin, channelsData, ts);
    }
    // const reasonSummary = reasons ? `, ${totalReasons} reasons (e.g., ${Object.values(reasons)[0] || 'none'})` : '';
    // plugin.log(`Processed ${dataSetRef}: ${result.count} entries, ${includedCount} channels${reasonSummary}`); // Removed log
}

// Process direct read
function processDirectValues(plugin, result, ts) {
    const channelsData = [];
    result.forEach(item => {
        const mapEntry = getDirectChannelMap().get(item.dataRef);
        if (!mapEntry) {
            // plugin.log(`No map for ${item.dataRef}`); // Removed log
            return;
        }

        let value = null;
        let chstatus = 0;
        if (item.isValid) {
            value = getNested(item.value, mapEntry.valuePath);
            if (item.value.q > 0 || item.value.t > 0) chstatus = 1;
            if (value === undefined || value === null) {
                chstatus = 1;
                // plugin.log(`Path ${mapEntry.valuePath} not found in ${item.dataRef}`); // Removed log
            }
        } else {
            chstatus = 2;
            // plugin.log(`Direct error ${item.dataRef}: ${item.errorReason}`); // Removed log
        }
        channelsData.push({ id: mapEntry.id, value, chstatus });
    });

    if (channelsData.length > 0) {
        sendChannelData(plugin, channelsData, ts);
    }
    // plugin.log(`Processed direct: ${result.length} refs`); // Removed log
}

module.exports = {
    sendChannelData,
    processDataSetValues,
    processDirectValues
};