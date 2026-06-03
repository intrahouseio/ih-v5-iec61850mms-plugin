/**
 * Polling (опрос) каналов
 */

class Poller {
    constructor(plugin, client, utils, mappings) {
        this.plugin = plugin;
        this.client = client;
        this.utils = utils;
        this.mappings = mappings;

        this.dataSetPollingTimers = new Map(); // dataSetRef -> {timer, isPolling}
        this.directPollingTimer = null;
        this.directPollingIsPolling = false;
        this.nodeChannelMap = null;
    }

    /**
     * Запускает polling для DataSet
     * @param {Object} node - Узел (DataSet)
     * @param {Map} nodeChannelMap - Мапа каналов
     */
    startDataSetPolling(node, nodeChannelMap) {
        this.nodeChannelMap = nodeChannelMap;
        const { dataSetRef, polldelay, pollInterval } = node;

        if (this.dataSetPollingTimers.has(dataSetRef)) {
            this.stopDataSetPolling(dataSetRef);
        }

        let isPolling = false;

        const timer = setInterval(async () => {
            if (isPolling) return;

            isPolling = true;
            try {
                const result = await this.client.readDataSetValues([dataSetRef]);
                this.mappings.processDataSetValues(
                    this.plugin,
                    this.nodeChannelMap,
                    dataSetRef,
                    result
                );

                // Задержка между запросами
                if (pollInterval > 0) {
                    await this.utils.delay(pollInterval);
                }
            } catch (err) {
                this.plugin.log(`Polling error for DataSet ${dataSetRef}: ${err.message}`, 2);
            } finally {
                isPolling = false;
            }
        }, polldelay);

        this.dataSetPollingTimers.set(dataSetRef, { timer, isPolling });
        this.plugin.log(`Started polling DataSet ${dataSetRef} every ${polldelay}ms`, 0);
    }

    /**
     * Останавливает polling для DataSet
     * @param {string} dataSetRef - Ссылка на DataSet
     */
    stopDataSetPolling(dataSetRef) {
        const timerData = this.dataSetPollingTimers.get(dataSetRef);
        if (timerData) {
            clearInterval(timerData.timer);
            this.dataSetPollingTimers.delete(dataSetRef);
            this.plugin.log(`Stopped polling for DataSet ${dataSetRef}`, 0);
        }
    }

    /**
     * Запускает polling для прямых каналов
     * @param {Array} channels - Массив прямых каналов
     * @param {Map} nodeChannelMap - Мапа каналов
     */
    startDirectPolling(channels, nodeChannelMap) {
        this.nodeChannelMap = nodeChannelMap;
        this.directChannels = channels;
        
        if (this.directPollingTimer) {
            clearInterval(this.directPollingTimer);
        }

        const pollDelay = 5000; // Основной интервал опроса

        this.directPollingTimer = setInterval(async () => {
            if (this.directPollingIsPolling || channels.length === 0) return;

            this.directPollingIsPolling = true;
            try {
                const dataRefs = channels.map(c => c.dataRef);

                if (dataRefs.length > 0) {
                    const result = await this.client.readData(dataRefs);
                    this.mappings.processDirectChannels(
                        this.plugin,
                        channels,
                        result
                    );

                    // Задержка между запросами
                    const pollInterval = Math.max(...channels.map(c => c.pollInterval || 1000), 1000);
                    await this.utils.delay(pollInterval);
                }
            } catch (err) {
                this.plugin.log(`Direct polling error: ${err.message}`, 2);
            } finally {
                this.directPollingIsPolling = false;
            }
        }, pollDelay);

        this.plugin.log(`Started direct polling for ${channels.length} channels every ${pollDelay}ms`, 0);
    }

    /**
     * Останавливает все polling
     */
    stopAllPolling() {
        // Останавливаем DataSet polling
        for (const [dataSetRef] of this.dataSetPollingTimers) {
            this.stopDataSetPolling(dataSetRef);
        }

        // Останавливаем прямой polling
        if (this.directPollingTimer) {
            clearInterval(this.directPollingTimer);
            this.directPollingTimer = null;
            this.directPollingIsPolling = false;
            this.plugin.log('Stopped direct polling', 0);
        }
    }

    /**
     * Получает информацию о текущем polling
     * @returns {Object} - Статистика polling
     */
    getPollingInfo() {
        return {
            dataSetPollingCount: this.dataSetPollingTimers.size,
            directPollingActive: !!this.directPollingTimer,
            timers: Array.from(this.dataSetPollingTimers.keys())
        };
    }
}

module.exports = Poller;