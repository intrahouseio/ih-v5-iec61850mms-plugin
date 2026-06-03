/**
 * Управление репортами (reporting)
 */

class Reporter {
    constructor(plugin, client, utils, mappings) {
        this.plugin = plugin;
        this.client = client;
        this.utils = utils;
        this.mappings = mappings;

        this.enabledReports = new Set(); // rcbRef
        this.nodeChannelMap = null;
    }

    /**
     * Устанавливает мапу каналов
     * @param {Map} nodeChannelMap - Мапа DataSet -> каналы
     */
    setNodeChannelMap(nodeChannelMap) {
        this.nodeChannelMap = nodeChannelMap;
    }

    /**
     * Включает репортинг для узла
     * @param {Object} node - Узел (DataSet)
     */
    async enableReporting(node) {
        const { rcbRef, dataSetRef } = node;

        if (this.enabledReports.has(rcbRef)) {
            this.plugin.log(`Reporting already enabled for ${rcbRef}`, 1);
            return;
        }

        try {
            await this.client.enableReporting(rcbRef, dataSetRef);
            this.enabledReports.add(rcbRef);
            this.plugin.log(`Enabled reporting for ${rcbRef} on DataSet ${dataSetRef}`, 0);
        } catch (err) {
            this.plugin.log(`Failed to enable reporting for ${rcbRef}: ${err.message}`, 2);
            throw err;
        }
    }

    /**
     * Отключает репортинг
     * @param {string} rcbRef - RCB ссылка
     */
    async disableReporting(rcbRef) {
        if (!this.enabledReports.has(rcbRef)) {
            this.plugin.log(`Reporting not enabled for ${rcbRef}`, 1);
            return;
        }

        try {
            await this.client.disableReporting(rcbRef);
            this.enabledReports.delete(rcbRef);
            this.plugin.log(`Disabled reporting for ${rcbRef}`, 0);
        } catch (err) {
            this.plugin.log(`Failed to disable reporting for ${rcbRef}: ${err.message}`, 2);
        }
    }

    /**
     * Обрабатывает входящий репорт
     * @param {Object} reportData - Данные репорта
     */
    processReport(reportData) {
        const { rcbRef, values, totalElementsProcessed } = reportData;

        if (!this.nodeChannelMap) {
            this.plugin.log(`No node channel map available for report ${rcbRef}`, 2);
            return;
        }

        // Находим DataSet по RCB
        const dataSetRef = this.mappings.findDataSetByRcb(this.nodeChannelMap, rcbRef);
        if (!dataSetRef) {
            this.plugin.log(`No DataSet mapping found for report RCB: ${rcbRef}`, 2);
            return;
        }

        const result = {
            isValid: true,
            values: values,
            count: totalElementsProcessed || Object.keys(values).length
        };

        this.mappings.processDataSetValues(
            this.plugin,
            this.nodeChannelMap,
            dataSetRef,
            result
        );

        this.plugin.log(`Report processed for ${rcbRef}, elements: ${result.count}`, 1);
    }

    /**
     * Отключает все репорты
     */
    async disableAllReports() {
        const promises = Array.from(this.enabledReports).map(rcbRef =>
            this.disableReporting(rcbRef).catch(err => {
                this.plugin.log(`Error disabling report ${rcbRef}: ${err.message}`, 2);
            })
        );

        await Promise.all(promises);
        this.enabledReports.clear();
        this.plugin.log('All reports disabled', 0);
    }

    /**
     * Получает информацию о текущих репортах
     * @returns {Object} - Статистика репортов
     */
    getReportingInfo() {
        return {
            enabledReportsCount: this.enabledReports.size,
            enabledReports: Array.from(this.enabledReports)
        };
    }
}

module.exports = Reporter;