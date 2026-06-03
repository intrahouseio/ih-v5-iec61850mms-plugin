const { MmsClient } = require("@amigo9090/ih-libiec61850-node");
const util = require("util");
const Scanner = require("./lib/scanner");

module.exports = async function app(plugin) {
    let client;
    let nextTimer; // Таймер следующего опроса
    let waiting = false; // Флаг ожидания завершения операции
    let toWrite = []; // Массив команд на запись
    let readQueue = []; // Очередь запросов на чтение
    let channels = {}; // Все каналы {id: {config}}
    let directChannels = []; // Прямые каналы
    let dataSets = new Map(); // DataSets: dataSetRef -> {node, channels: []}
    let isConnected = false; // Флаг состояния подключения
    let dataSetcached = false; // Флаг что Dataset закешированы
    let directChannelscached = false;
    let isShuttingDown = false;
    let reportEnabled = false; // Флаг включённого reporting
    const scanner = new Scanner(plugin);

    /**
 * Преобразует значение в формат, подходящий для отправки
 * - Числа и строки оставляем как есть
 * - Boolean → 1/0
 * - Объекты → JSON строка
 */
    function prepareValue(value) {
        if (value === null || value === undefined) {
            return null;
        }

        if (typeof value === "boolean") {
            return value ? 1 : 0;
        }

        if (typeof value === "number" || typeof value === "string") {
            return value;
        }

        // Если это объект (cVal, mag, ang и т.д.)
        if (typeof value === "object") {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return String(value);
            }
        }

        return String(value);
    }

    /**
     * Универсальное извлечение значения IEC 61850
     * Учитывает dataType (dataObject / dataAttribute) и fc
     */
    function extractValue(obj, fullRef = "", channel = {}) {
        if (obj === null || obj === undefined) return null;
        if (typeof obj !== "object") {
            if (typeof obj === "boolean") return obj ? 1 : 0;
            return obj;
        }

        const { dataType = "dataObject", cdc = null, fc = null } = channel;

        // ====================== DATA OBJECT ======================
        if (dataType === "dataObject") {
            // Парсинг по CDC (самый приоритетный)
            if (cdc) {
                const cdcUpper = cdc.toUpperCase();

                if (["SPS", "DPS", "INS", "ENS", "ACT", "ACD"].includes(cdcUpper)) {
                    if (obj.general !== undefined) return extractValue(obj.general);
                    if (obj.stVal !== undefined) return extractValue(obj.stVal);
                }

                if (["MV", "CMV", "SAV", "DEL"].includes(cdcUpper)) {
                    if (obj.mag?.f !== undefined) return obj.mag.f;
                    if (obj.mag?.i !== undefined) return obj.mag.i;
                    if (obj.f !== undefined) return obj.f;
                }

                if (cdcUpper === "CMV") {
                    if (obj.cVal) return extractCVal(obj.cVal);
                }
            }

            // Общие правила для DataObject
            if (obj.general !== undefined) return extractValue(obj.general);
            if (obj.stVal !== undefined) return extractValue(obj.stVal);
        }

        // ====================== DATA ATTRIBUTE ======================
        if (dataType === "dataAttribute") {
            const fcUpper = (fc || "").toUpperCase();

            if (fcUpper === "ST") {
                if (obj.stVal !== undefined) return extractValue(obj.stVal);
                if (obj.general !== undefined) return extractValue(obj.general);
            }

            if (fcUpper === "MX") {
                if (obj.mag?.f !== undefined) return obj.mag.f;
                if (obj.mag?.i !== undefined) return obj.mag.i;
                if (obj.f !== undefined) return obj.f;
            }

            if (fcUpper === "CF") {
                if (obj.ctlModel !== undefined) return obj.ctlModel;
            }
        }

        // ====================== ОБЩИЕ FALLBACK ======================
        if (obj.f !== undefined) return obj.f;
        if (obj.i !== undefined) return obj.i;
        if (obj.stVal !== undefined) return extractValue(obj.stVal);
        if (obj.general !== undefined) return extractValue(obj.general);
        if (obj.ctlVal !== undefined) return extractValue(obj.ctlVal);

        if (obj.mag?.f !== undefined) return obj.mag.f;
        if (obj.mag?.i !== undefined) return obj.mag.i;
        if (obj.ang?.f !== undefined) return obj.ang.f;

        if (obj.cVal) {
            return extractCVal(obj.cVal);
        }

        // Фазовые величины
        const phases = ['phsA', 'phsB', 'phsC', 'phsAB', 'phsBC', 'phsCA', 'res', 'neut'];
        for (const phase of phases) {
            if (fullRef.includes(`.${phase}`) && obj[phase]) {
                return extractValue(obj[phase], fullRef, channel);
            }
        }

        return obj; // возвращаем объект как есть
    }

    /** Вспомогательная функция для cVal */
    function extractCVal(cVal) {
        if (!cVal) return null;
        const result = { cVal: {} };

        if (cVal.mag?.f !== undefined) result.cVal["mag.f"] = cVal.mag.f;
        if (cVal.mag?.i !== undefined) result.cVal["mag.i"] = cVal.mag.i;
        if (cVal.ang?.f !== undefined) result.cVal["ang.f"] = cVal.ang.f;

        return Object.keys(result.cVal).length > 0 ? result : cVal;
    }

    /**
  * Определяем "основной" путь для канала
  */
    function determineValuePath(dataRef) {
        if (!dataRef) return "";

        const ref = dataRef.toUpperCase();

        if (ref.includes("[ST]")) return "";
        if (ref.includes("[MX]")) return "";        // оставляем пустым — extractValue сам разберётся
        if (ref.includes("[CO]")) return "Oper.ctlVal";
        if (ref.includes("[CF]")) return "ctlModel";

        return "";
    }

    /**
     * Включает reporting для всех DataSet'ов в режиме "report"
     */
    async function enableAllReports() {
        if (!client || !isConnected || !dataSetcached) return;

        let enabledCount = 0;
        for (const [dataSetRef, ds] of dataSets.entries()) {
            if (ds.node.dataMode === "report" && ds.node.rcbRef) {
                try {
                    plugin.log(`Enabling reporting: RCB=${ds.node.rcbRef} → DS=${dataSetRef}`, 1);
                    await client.enableReporting(ds.node.rcbRef, dataSetRef);
                    enabledCount++;
                } catch (err) {
                    plugin.log(`Failed to enable reporting for ${ds.node.rcbRef}: ${err.message}`, 2);
                }
            }
        }

        if (enabledCount > 0) {
            reportEnabled = true;
            plugin.log(`✅ Reporting enabled for ${enabledCount} RCB(s)`, 0);
        }
    }

    /**
     * Заполнение очереди чтения (только polling)
     */
    function fillReadQueue() {
        readQueue = [];

        // 1. Прямые каналы - один запрос на все каналы
        if (directChannels.length > 0) {
            const dataRefs = directChannels.map((c) => c.ref).filter((ref) => ref);
            if (dataRefs.length > 0) {
                readQueue.push({
                    type: "direct",
                    dataRefs: dataRefs,
                    channels: directChannels,
                });
            }
        }

        // 2. Только DataSets в режиме polling
        for (const [dataSetRef, dataSet] of dataSets.entries()) {
            if (dataSet.node.dataMode === "polling" && dataSet.channels.length > 0) {
                readQueue.push({
                    type: "dataset",
                    dataSetRef: dataSetRef,
                    dataSet: dataSet,
                });
            }
        }

        //return readQueue.length;
        //plugin.log(`Read queue filled: ${readQueue.length} items (polling only)`, 1);
    }

    /**
 * Основной цикл обработки очереди
 */
    async function processQueue() {
        if (isShuttingDown || waiting || !isConnected || !client) {
            return;
        }

        waiting = true;

        try {
            // Приоритет — запись
            if (toWrite.length > 0) {
                await write();
                return;
            }

            // Если очередь пуста — заполняем
            if (readQueue.length === 0) {
                fillReadQueue();
            }

            if (readQueue.length === 0) {
                // Нечего читать — следующий запуск через нормальный интервал
                const delay = plugin.params.data.polldelay || 5000;
                nextTimer = setTimeout(processQueue, delay);
                return;
            }

            // Есть что читать — обрабатываем один элемент
            await processReadItem();

        } catch (err) {
            plugin.log(`Queue processing error: ${err.message}`, 2);
        } finally {
            waiting = false;

            if (isShuttingDown) return;

            // === КЛЮЧЕВОЕ: централизованное управление таймером ===
            if (readQueue.length > 0) {
                // Если в очереди остались элементы — продолжаем относительно быстро
                nextTimer = setTimeout(processQueue, plugin.params.data.polldelay);
            } else {
                // Когда очередь полностью обработана — используем polldelay
                const delay = plugin.params.data.polldelay || 5000;
                nextTimer = setTimeout(processQueue, delay);
            }
        }
    }

    /**
     * Обработка одного элемента из очереди чтения
     */
    async function processReadItem() {
        if (isShuttingDown || !isConnected || readQueue.length === 0) {
            return;
        }

        const item = readQueue.shift();
        if (!item) return;

        const results = [];
        const ts = Date.now();

        try {
            if (item.type === "direct") {
                if (!directChannelscached) {
                    plugin.log(`Direct channels not yet cached, skipping`, 1);
                    readQueue.push(item);
                    return;
                }

                plugin.log(`Reading direct channels: ${item.dataRefs.length} refs`, 1);

                const readResult = await client.readData(item.dataRefs);

                item.channels.forEach((channel, index) => {
                    const result = Array.isArray(readResult) ? readResult[index] : readResult;
                    let value = null;
                    let chstatus = 2;
                    let quality = null;
                    let timestamp = ts;

                    if (result?.isValid) {
                        const rawValue = result.value;
                        value = extractValue(rawValue, channel.ref, channel);

                        if (rawValue && typeof rawValue === "object") {
                            quality = rawValue.q !== undefined ? rawValue.q : null;
                            if (rawValue.t) {
                                timestamp = typeof rawValue.t === "number"
                                    ? rawValue.t
                                    : new Date(rawValue.t).getTime();
                            }
                        }
                        chstatus = (value !== undefined && value !== null) ? 0 : 1;
                    }

                    results.push({
                        id: channel.id,
                        value: prepareValue(value),
                        chstatus,
                        quality,
                        ts: timestamp,
                    });
                });

            }
            else if (item.type === "dataset") {
                if (!dataSetcached) {
                    plugin.log(`DataSet ${item.dataSetRef} not yet cached, skipping`, 1);
                    readQueue.push(item);
                    return;
                }

                plugin.log(`Reading DataSet: ${item.dataSetRef}`, 1);

                const datasetResult = await client.pollDataSetValues(item.dataSetRef);
                const dsItems = Array.isArray(datasetResult) ? datasetResult : [datasetResult];

                for (const dataSet of dsItems) {
                    if (!dataSet?.isValid || !dataSet.values) {
                        item.dataSet.channels.forEach(ch =>
                            results.push({ id: ch.id, value: null, chstatus: 2, ts })
                        );
                        continue;
                    }

                    item.dataSet.channels.forEach((channel) => {
                        const valObj = dataSet.values[channel.ref];
                        const value = valObj ? extractValue(valObj, channel.ref, channel) : null;
                        const chstatus = (value !== undefined && value !== null) ? 0 : 1;

                        results.push({
                            id: channel.id,
                            value: prepareValue(value),
                            chstatus,
                            quality: valObj?.q,
                            ts: valObj?.t ? new Date(valObj.t).getTime() : ts,
                        });
                    });
                }
            }

            if (results.length > 0) {
                plugin.sendData(results);
                plugin.log(`Sent ${results.length} values from ${item.type}`, 1);
            }

        } catch (err) {
            plugin.log(`Read error for ${item.type}: ${err.message}`, 2);

            const channelsList = item.type === "direct" ? item.channels : item.dataSet.channels;
            const errorResults = channelsList.map(ch => ({
                id: ch.id,
                value: null,
                chstatus: 2,
                ts,
            }));

            plugin.sendData(errorResults);
            readQueue.push(item);

        } finally {
            // **НЕ ставим здесь таймер!** — это делает processQueue
        }
    }
    /**
     * Запись данных
     */
    async function write() {
        if (toWrite.length === 0 || !isConnected || !client) {
            toWrite = [];
            return;
        }

        try {
            plugin.log(`Writing ${toWrite.length} items`, 1);

            const writePromises = toWrite.map(async (item) => {
                const { id, value, ref } = item;
                const channel = channels[id];
                let curValue;
                if (!channel || !channel.ref) {
                    plugin.log(`No ref for channel ${id}`, 2);
                    return;
                }
                if (channel.cdc == "DPC" || channel.cdc == "SPC") {
                    curValue = value == 1 ? true : false
                } else {
                    curValue = value
                }
                try {
                    await client.controlObject(ref, curValue);
                    plugin.log(`Write successful for ${channel.ref}: ${curValue}`, 1);
                } catch (err) {
                    plugin.log(`Write error for ${channel.ref}: ${err.message}`, 2);
                }
            });

            await Promise.all(writePromises);
        } catch (err) {
            plugin.log(`Write operation error: ${err.message}`, 2);
        } finally {
            toWrite = [];
        }
    }

    /**
     * Подключение к серверу
     */
    async function connect() {
        const params = plugin.params.data;
        const {
            ip,
            nodeport = 102,
            clientID = "mms_client1",
            restarttime = 5,
        } = params;

        plugin.log(`Connecting to ${ip}:${nodeport}...`, 0);
        plugin.send({ type: "state", data: 10 });

        client = new MmsClient(async (event, data) => {
            //plugin.log("Event " + event);
            //plugin.log("Data " + util.inspect(data));
            if (event === "conn") {
                if (data.event === "opened") {
                    isConnected = true;
                    plugin.log("Connection opened", 1);
                    const arrDataSets = [...dataSets.keys()];
                    plugin.log("arrDataSets " + util.inspect(arrDataSets), 1);
                    if (arrDataSets.length > 0) {
                        plugin.log(`Caching DataSet models: ${[...dataSets.keys()].join(", ")}`, 1);
                        await client.readDataSetModel(arrDataSets);
                        dataSetcached = true;
                        // Включаем reporting сразу после кэширования модели
                        await enableAllReports();
                    }
                    //plugin.log(`Caching directChannels models: ${util.inspect(directChannels, null, 4)}`, 1);
                    const dataRefs = directChannels.map((c) => c.ref).filter((ref) => ref);
                    if (dataRefs.length > 0) {
                        await client.readDataModel(dataRefs);
                        directChannelscached = true;
                    }

                    processQueue();
                }

                if (data.event === "closed") {
                    plugin.log("Connection closed", 1);
                    isConnected = false;
                    isShuttingDown = true;
                    reportEnabled = false;
                    clearTimeout(nextTimer);
                    plugin.send({ type: "state", data: 10 });
                }

                if (data.event === "stateChanged" && data.isConnected) {
                    isConnected = true;
                    plugin.log("Connection restored", 1);

                    if (dataSetcached) {
                        await enableAllReports(); // заново подписываемся после реконнекта
                    }
                    processQueue();
                }

                if (data.event === "reconnecting") {
                    plugin.log(`Reconnecting: ${data.reason}`, 1);
                }
            }

            // Обработка отчётов
            if (event === "data" && data.event === "report") {
                plugin.log("Report " + util.inspect(data));
                processReport(data);
            }

            if (data.event === "data" && data.type === "error") {
                plugin.log(`MMS Error: ${data.reason}`, 2);
            }

            if (data.event === "data" && data.type === "control" && data.event === "reportingEnabled") {
                plugin.log(`Reporting ENABLED for ${data.rcbRef}`, 1);
            }
        });

        try {
            await client.connect({
                ip,
                port: parseInt(nodeport),
                clientID,
                reconnectDelay: parseInt(restarttime),
            });
        } catch (err) {
            plugin.log(`Connection error: ${err.message}`, 2);
            throw err;
        }
    }

    function processReport(reportData) {
        const { rcbRef, values = {}, timestamp } = reportData;

        let targetDataSet = null;
        for (const ds of dataSets.values()) {
            if (ds.node.rcbRef === rcbRef) {
                targetDataSet = ds;
                break;
            }
        }

        if (!targetDataSet) {
            plugin.log(`No DataSet found for report RCB: ${rcbRef}`, 2);
            return;
        }

        const results = [];
        const ts = timestamp ? new Date(timestamp).getTime() : Date.now();

        targetDataSet.channels.forEach((channel) => {
            const valObj = values[channel.ref];
            let value = null;
            let chstatus = 0;

            if (valObj) {
                value = extractValue(valObj, channel.ref, channel);   // ← передаём dataRef!

                if (value === undefined || value === null) {
                    chstatus = 1;
                } else if (typeof value === "number" || typeof value === "boolean") {
                    chstatus = 0;
                }
            } else {
                chstatus = 2;
            }

            results.push({
                id: channel.id,
                value: prepareValue(value),
                chstatus,
                quality: valObj?.q,
                ts
            });
        });

        if (results.length > 0) {
            plugin.sendData(results);
            plugin.log(`Report processed for ${rcbRef}: ${results.length} values`, 1);
        }
    }

    /**
     * Обработка и группировка каналов
     */
    async function processChannels() {
        const allChannels = await plugin.channels.get();
        plugin.log(`Got ${allChannels.length} channels`, 1);

        channels = {};
        directChannels = [];
        dataSets.clear();
        readQueue = [];
        toWrite = [];

        // Получаем узлы
        try {
            const nodes = await plugin.nodes.get();
            plugin.log("nodes " + util.inspect(nodes))
            nodes.forEach((node) => {
                if (node.foldertype === "node" && node.dataSetRef) {
                    dataSets.set(node.dataSetRef, {
                        node: {
                            dataSetRef: node.dataSetRef,
                            dataMode: node.dataMode || "polling",
                            rcbRef: node.rcbRef,
                            polldelay: parseInt(node.polldelay) || 5000,
                        },
                        channels: [],
                    });
                }
            });
        } catch (err) {
            plugin.log(`Error getting nodes: ${err.message}`, 2);
        }

        allChannels.forEach((ch) => {
            channels[ch.id] = {
                id: ch.id,
                ref: ch.ref,
                valuePath: determineValuePath(ch.ref),
                dataType: ch.dataType || "dataObject",
                cdc: ch.cdc || null,
                fc: ch.fc || null,
                w: ch.w || 0,
            };

            if (ch.dataSetRef && dataSets.has(ch.dataSetRef)) {
                dataSets.get(ch.dataSetRef).channels.push(channels[ch.id]);
            } else if (!ch.parentnodefolder) {
                directChannels.push(channels[ch.id]);
            }
        });

        plugin.log(
            `Processed: ${Object.keys(channels).length} channels, ${directChannels.length} direct, ${dataSets.size} DataSets`,
            0,
        );
    }

    /**
     * Команда на запись
     */
    function handleAct(message) {
        plugin.log(`Act command: ${message.data.length} items`, 1);

        if (!message.data) return;

        message.data.forEach((item) => {
            toWrite.push({ id: item.id, value: item.value, ref: item.ref });
        });

        clearTimeout(nextTimer);
        processQueue();
    }

    /**
     * Изменение каналов
     */
    async function handleChannelsChange(data) {
        plugin.log("Channels changed, reloading...", 1);

        clearTimeout(nextTimer);
        waiting = false;
        toWrite = [];
        readQueue = [];

        try {
            await processChannels();

            const arrDataSets = [...dataSets.keys()];
            if (arrDataSets.length > 0) {
                plugin.log(`Caching DataSet models: ${[...dataSets.keys()].join(", ")}`, 1);
                await client.readDataSetModel(arrDataSets);
                dataSetcached = true;
                // Включаем reporting сразу после кэширования модели
                await enableAllReports();
            }
            //plugin.log(`Caching directChannels models: ${util.inspect(directChannels, null, 4)}`, 1);
            const dataRefs = directChannels.map((c) => c.ref).filter((ref) => ref);
            if (dataRefs.length > 0) {
                await client.readDataModel(dataRefs);
                directChannelscached = true;
            }
            if (isConnected) {
                processQueue();
            }
        } catch (err) {
            plugin.log(`Error reloading channels: ${err.message}`, 2);
        }
    }

    /**
     * Команды плагина
     */
    async function handleCommand(msg) {
        plugin.log(`Command: ${util.inspect(msg, { depth: 1 })}`, 1);

        if (msg.param === "browse") {
            if (client && isConnected) {
                try {
                    const discovered = await client.browseDataModel();
                    plugin.send({
                        type: "scan",
                        op: "list",
                        data: discovered,
                        uuid: msg.uuid,
                    });
                } catch (err) {
                    plugin.log(`Browse error: ${err.message}`, 2);
                }
            }

            const result = {
                success: isConnected,
                type: "command",
                unit: msg.unit,
                uuid: msg.uuid,
            };
            plugin.sendResponse(result, isConnected ? 1 : 0);
        }
    }

    plugin.onScan((scanObj) => {
        if (!scanObj) return;
        if (scanObj.stop) {
            scanner.stop();
            plugin.log("Scanner stop by user", 1)
        } else {
            scanner.request(client, scanObj.uuid);
        }
    });

    if (plugin.onScanexpand) plugin.onScanexpand((scanObj) => {
        scanner.scanExpand(scanObj);
    });

    /**
     * Очистка
     */
    async function cleanup() {
        isShuttingDown = true;
        clearTimeout(nextTimer);
        waiting = false;

        // Отключаем reporting перед закрытием (рекомендуется)
        if (client && isConnected && reportEnabled) {
            for (const ds of dataSets.values()) {
                if (ds.node.rcbRef) {
                    try {
                        await client.disableReporting(ds.node.rcbRef);
                    } catch (e) { }
                }
            }
        }

        if (client) {
            try {
                plugin.log("Closing client...");
                await client.close().catch(() => { });
                plugin.log("Client closed gracefully", 1);
            } catch (err) {
                plugin.log(`Close error: ${err.message}`, 2);
            }
        }
        await new Promise((r) => setTimeout(r, 400));
        plugin.log("Plugin stopped", 0);
    }

    // ===== ОСНОВНОЙ КОД =====
    try {
        await processChannels();
        await connect();


        plugin.onAct(handleAct);
        plugin.onChange("channels", handleChannelsChange);
        plugin.onCommand(handleCommand);

        process.on("SIGTERM", async () => {
            plugin.log("SIGTERM received, shutting down gracefully", 0);
            await cleanup();
            process.exit(0);
        });

        process.on("SIGINT", async () => {
            plugin.log("SIGINT received, shutting down gracefully", 0);
            await cleanup();
            process.exit(0);
        });

        if (plugin.onStop) {
            plugin.onStop(async () => {
                plugin.log("Stop requested", 0);
                await cleanup();
                plugin.exit(0, "Stopped by user");
            });
        }
    } catch (err) {
        plugin.log(`Plugin error: ${err.message}`, 2);
        plugin.exit(8, `Failed: ${err.message}`);
    }
};