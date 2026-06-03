/**
 * Маппинг каналов и узлов
 */

/**
 * Извлекает узлы и каналы из данных плагина
 * @param {Array} nodes - Узлы (DataSets)
 * @param {Array} channels - Каналы
 * @param {Object} plugin - Объект плагина
 * @returns {Object} - Объект с узлами и каналами
 */
function extractNodesAndChannels(nodes, channels, plugin) {
    const nodeDataList = [];
    const directChannels = [];
    const nodeChannelMap = new Map();
    const nodeIdToDataSetMap = new Map(); // _id узла -> dataSetRef

    // Обрабатываем узлы (DataSets)
    nodes.forEach(node => {
        if (node.foldertype !== 'node') return;

        const nodeData = {
            _id: node._id,
            chan: node.chan || 'Unnamed Node',
            dataSetRef: node.dataSetRef || node.ref,
            dataMode: node.dataMode?.id || node.dataMode || 'polling',
            rcbRef: node.rcbRef,
            polldelay: parseInt(node.polldelay) || 5000,
            pollInterval: parseInt(node.pollInterval) || 1000
        };

        nodeDataList.push(nodeData);
        nodeIdToDataSetMap.set(node._id, nodeData.dataSetRef);

        plugin.log(`Found node: ${nodeData.chan}, DataSet: ${nodeData.dataSetRef}, Mode: ${nodeData.dataMode}`, 1);
    });

    // Обрабатываем каналы
    channels.forEach(ch => {
        // Проверяем, находится ли канал внутри узла DataSet
        const isInNode = ch.parentnodefolder || (nodeIdToDataSetMap.has(ch.parent) && ch.parent !== 'iec61850mms1_all');
        
        if (isInNode) {
            // Канал внутри узла DataSet
            const nodeId = ch.parentnodefolder || ch.parent;
            const dataSetRef = nodeIdToDataSetMap.get(nodeId) || ch.dataSetRef;
            
            if (!dataSetRef) {
                plugin.log(`Channel ${ch.chan} has no DataSet reference, skipping`, 2);
                return;
            }

            if (!nodeChannelMap.has(dataSetRef)) {
                nodeChannelMap.set(dataSetRef, {
                    node: nodeDataList.find(n => n.dataSetRef === dataSetRef) || {
                        dataSetRef,
                        dataMode: ch.dataMode || 'polling',
                        rcbRef: ch.rcbRef,
                        polldelay: parseInt(ch.polldelay) || 5000
                    },
                    channels: []
                });
            }

            const channelData = {
                id: ch.id || ch.chanId,
                fullRef: ch.ref || ch.fullRef,
                valuePath: ch.valuePath || this.utils.determineValuePath(ch.ref),
                chan: ch.chan,
                w: ch.w || 0,
                index: parseInt(ch.index) || 0
            };

            nodeChannelMap.get(dataSetRef).channels.push(channelData);
            
            plugin.log(`Added channel ${channelData.id} to DataSet ${dataSetRef}, ref: ${channelData.fullRef}`, 1);
        } else {
            // Прямой канал (не в узле)
            const channelData = {
                id: ch.id || ch.chanId,
                dataRef: ch.ref || ch.fullRef,
                valuePath: ch.valuePath || this.utils.determineValuePath(ch.ref),
                chan: ch.chan,
                w: ch.w || 0,
                pollInterval: parseInt(ch.pollInterval) || 1000
            };

            directChannels.push(channelData);
            
            plugin.log(`Added direct channel ${channelData.id}, ref: ${channelData.dataRef}`, 1);
        }
    });

    // Логируем результат
    plugin.log(
        `Extracted: ${nodeDataList.length} nodes, ${directChannels.length} direct channels, ${nodeChannelMap.size} DataSets with channels`, 
        0
    );

    return {
        nodes: nodeDataList,
        directChannels,
        nodeChannelMap
    };
}

/**
 * Обрабатывает значения DataSet
 */
function processDataSetValues(plugin, nodeChannelMap, dataSetRef, result) {
    const map = nodeChannelMap.get(dataSetRef);
    if (!map) {
        plugin.log(`No channel map for DataSet ${dataSetRef}`, 2);
        return;
    }

    const channelsData = [];

    if (!result.isValid) {
        // Все каналы в ошибке
        map.channels.forEach(ch => {
            channelsData.push({
                id: ch.id,
                value: null,
                chstatus: 2
            });
        });
        this.utils.sendChannelData(plugin, channelsData);
        return;
    }

    // Обрабатываем каждый канал в DataSet
    map.channels.forEach(ch => {
        let value = null;
        let chstatus = 0;

        // Ищем значение по fullRef в result.values
        const valObj = result.values[ch.fullRef];
        if (valObj) {
            value = this.utils.extractValue(valObj, ch.valuePath);
            if (value === undefined) {
                chstatus = 1; // Неопределенность
                plugin.log(`Path ${ch.valuePath} not found in ${ch.fullRef}`, 2);
            }
        } else {
            chstatus = 2; // Ошибка - нет данных
            plugin.log(`FullRef ${ch.fullRef} not found in DataSet ${dataSetRef}`, 2);
        }

        channelsData.push({
            id: ch.id,
            value,
            chstatus
        });
    });

    this.utils.sendChannelData(plugin, channelsData);

    plugin.log(
        `Processed DataSet ${dataSetRef}: ${result.count || Object.keys(result.values).length} entries, ${map.channels.length} channels`, 
        1
    );
}

/**
 * Обрабатывает значения прямых каналов
 */
function processDirectChannels(plugin, channels, result) {
    const channelsData = [];

    // Проверяем формат результата
    if (Array.isArray(result)) {
        // Формат: [{dataRef, isValid, value, errorReason}, ...]
        result.forEach((item, index) => {
            const channel = channels[index];
            if (!channel) return;

            if (item && item.isValid) {
                const value = this.utils.extractValue(item.value, channel.valuePath);
                channelsData.push({
                    id: channel.id,
                    value: value !== undefined ? value : null,
                    chstatus: value !== undefined ? 0 : 1
                });
            } else {
                plugin.log(
                    `Direct read error for ${channel.dataRef}: ${item?.errorReason || 'Unknown error'}`, 
                    2
                );
                channelsData.push({
                    id: channel.id,
                    value: null,
                    chstatus: 2
                });
            }
        });
    } else if (result && typeof result === 'object') {
        // Формат: {values: {...}} или другой
        channels.forEach(channel => {
            channelsData.push({
                id: channel.id,
                value: null,
                chstatus: 2
            });
        });
    }

    if (channelsData.length > 0) {
        this.utils.sendChannelData(plugin, channelsData);
        plugin.log(`Processed ${channelsData.length} direct channels`, 1);
    }
}

/**
 * Находит DataSet по RCB ссылке
 */
function findDataSetByRcb(nodeChannelMap, rcbRef) {
    for (const [dataSetRef, map] of nodeChannelMap.entries()) {
        if (map.node.rcbRef === rcbRef) {
            return dataSetRef;
        }
    }
    return null;
}

module.exports = {
    extractNodesAndChannels,
    processDataSetValues,
    processDirectChannels,
    findDataSetByRcb
};