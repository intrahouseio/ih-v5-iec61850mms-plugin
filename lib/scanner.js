/**
 * scanner.js
 *  Сканирование узлов IEC 61850 для показа их в виде дерева
 *  
 *  ИСПРАВЛЕНИЯ:
 *  1. isNodeType / isLeafType теперь case-insensitive (раньше из-за регистра узлы и листья часто попадали в "unknown")
 *  2. Для logicalNode (и dataObject) теперь создаются виртуальные группирующие узлы:
 *     - DataSets
 *     - Reports
 *     Под ними размещаются все DataSet / BR / RP.
 *     Это точно соответствует желаемой структуре дерева при первом сканировании:
 *     
 *     IEC 61850 Device
 *     ├── LLN0 (LN) (3 DataSets, 6 Reports)
 *     │   ├── DataSets
 *     │   │   ├── DataSet01 (DS)
 *     │   │   ├── DataSet02 (DS)
 *     │   │   └── DataSet03 (DS)
 *     │   └── Reports
 *     │       ├── BR$ReportBlock0301 (BR) - Buffered Report
 *     │       └── ...
 *     ├── LPHD1 (LN)
 *     ...
 *  3. Группы — это обычные узлы (nodeClass: 1), но они не расширяются (nodeType = dataSetsGroup / reportsGroup).
 *  4. childCount теперь считает группы + children (а не листья напрямую).
 *  5. Порядок элементов под группами сохраняется как в ответе сервера (можно добавить сортировку при необходимости).
 */

const util = require('util');

class Scanner {
    constructor(plugin) {
        this.plugin = plugin;
        this.status = 0;
        this.clientID = '';
        this.clients = new Set();
        this.scanArray = [];
        this.idSet = new Set();
        this.pendingTreeParts = [];
        this.session = null;
    }

    start(session, clientId = '') {
        this.status = 1;
        this.session = session;
        this.clientID = clientId;

        this.plugin.log(`Starting scanner for client: ${this.clientID}`, 1);

        this.scanArray = [
            {
                id: 'RootFolder',
                browseName: 'IEC 61850 Device',
                title: 'IEC 61850 Device  Loading ...',
                nodeClass: 1,
                parentId: '',
                children: []
            }
        ];
        this.idSet.clear();
        this.idSet.add('RootFolder');
        this.pendingTreeParts = [];

        const data = [this.makeTree()];
        this.clients.forEach(uuid => this.sendTree(uuid, data));
        this.status = 2;

        try {
            this.scanning('').then(() => {
                this.plugin.send({
                    type: 'scan',
                    op: 'update',
                    data: {
                        RootFolder: { title: 'IEC 61850 Device' }
                    },
                    scanid: 'root'
                });
                this.sendAllTreeParts();
                this.plugin.log('Initial scanning completed successfully', 1);
            }).catch((e) => {
                this.plugin.log('ERROR in scanning: ' + util.inspect(e), 2);
            });
        } catch (e) {
            this.stop();
            this.plugin.log('ERROR ' + util.inspect(e), 2);
        }
    }

    request(session, uuid, clientId = '') {
        this.clients.add(uuid);

        if (clientId) {
            this.clientID = clientId;
        }

        if (this.status == 2) {
            this.sendTree(uuid);
        } else if (this.status == 0) {
            this.start(session, clientId);
        }
    }

    async scanning(reference) {
        try {
            this.plugin.log(`Browsing data model for reference: ${reference || 'root'}`, 1);

            const dataModel = await this.session.browseDataModel(reference);

            this.plugin.log("DataModel " + util.inspect(dataModel))

            if (!dataModel) {
                this.plugin.log('No data model returned', 2);
                return;
            }

            let items = Array.isArray(dataModel) ? dataModel : [dataModel];

            this.plugin.log(`Found ${items.length} item(s) at level ${reference || 'root'}`, 1);

            let parentId = 'RootFolder';
            if (reference && reference !== '') {
                parentId = this.generateNodeId(reference);
            }

            for (const item of items) {
                // === Специальная обработка DataSet ===
                if (this.isDataSetType(item.type) && item.members && Array.isArray(item.members)) {
                    this.plugin.log(`Special handling for DataSet ${item.name} with ${item.members.length} members`, 1);

                    // Создаём/обновляем сам узел DataSet
                    await this.processDataModelItem(item, parentId);

                    // Добавляем members напрямую как листья
                    for (const member of item.members) {
                        const memberItem = {
                            reference: member.reference || `${item.reference}.${member.name}`,
                            name: member.name,
                            type: 'dataObject',
                            cdc: member.cdc || '',
                            value: member.value,
                            description: member.description || ''
                        };
                        await this.processDataModelItem(memberItem, this.generateNodeId(item.reference));
                    }
                }
                else {
                    // Обычная обработка всех остальных элементов
                    await this.processDataModelItem(item, parentId);
                }
            }

        } catch (e) {
            this.plugin.log('ERROR scanning data model: ' + util.inspect(e), 2);
            throw e;
        }
    }

    isNodeType(type) {
        if (!type) return false;
        const nodeTypes = ['logicalnode', 'dataobject', 'dataset', 'report', 'br', 'rp'];
        return nodeTypes.includes(type.toLowerCase());
    }

    isDataSetType(type) {
        if (!type) return false;
        return type.toLowerCase() === 'dataset';
    }

    isReportType(type) {
        if (!type) return false;
        const reportTypes = ['report', 'br', 'rp'];
        return reportTypes.includes(type.toLowerCase());
    }

    isLeafType(type) {
        if (!type) return false;
        const leafTypes = ['dataattribute'];
        return leafTypes.includes(type.toLowerCase());
    }

    getParentFolderInfo(parentId) {
        if (!parentId || parentId === 'RootFolder') {
            return {
                id: 'RootFolder',
                title: 'IEC 61850 Device',
                foldertype: ''
            };
        }

        const parentNode = this.scanArray.find(node => node.id === parentId);
        if (parentNode) {
            let foldertype = '';   // по умолчанию node

            // Специально для Report делаем foldertype = 'node'
            if (parentNode.isReport || parentNode.nodeType === 'BR' || parentNode.nodeType === 'RP' || parentNode.nodeType === 'REPORT') {
                foldertype = 'node';
            }
            // Для DataSet тоже можно явно указать
            else if (parentNode.isDataSet || parentNode.nodeType === 'dataset') {
                foldertype = 'node';
            }
            // Для групп (DataSets / Reports) тоже node
            else if (parentNode.nodeType === 'dataSetsGroup' || parentNode.nodeType === 'reportsGroup') {
                foldertype = '';
            }

            return {
                id: parentId,
                title: parentNode.title || parentNode.browseName || 'Unnamed',
                foldertype: foldertype
            };
        }

        return {
            id: parentId,
            title: 'Unnamed',
            foldertype: ''
        };
    }

        async processDataModelItem(item, parentId) {
        try {
            const itemId = this.generateNodeId(item.reference, parentId);
            const itemTitle = this.getItemTitle(item);

            if (this.idSet.has(itemId)) {
                // this.plugin.log(`Skipped duplicate: ${item.name}`, 1);
                return;
            }

            this.idSet.add(itemId);

            const parentFolder = this.getParentFolderInfo(parentId);
            const parentNode = this.scanArray.find(n => n.id === parentId) || {};

            // Передаём информацию о DataSet / Report вниз
            if (parentNode.isDataSet || parentNode.nodeType === 'dataset') {
                parentFolder.dataSetRef = parentNode.dataSetRef || parentNode.reference;
                parentFolder.dataMode = 'polling';
                parentFolder.nodeType = 'dataset';
                parentFolder.polldelay = 5000;
            } else if (parentNode.isReport || ['BR', 'RP', 'REPORT'].includes(parentNode.nodeType)) {
                parentFolder.dataMode = 'report';
                parentFolder.rcbRef = parentNode.rcbRef || parentNode.reference;
                parentFolder.dataSetRef = parentNode.datasetRef || parentNode.originalDatasetRef;
                parentFolder.reportType = parentNode.reportType;
            }

            // ==================== DATASET ====================
            if (this.isDataSetType(item.type)) {
                const treeNode = {
                    id: itemId,
                    browseName: item.name,
                    title: itemTitle + (item.memberCount ? ` (${item.memberCount} members)` : ''),
                    nodeClass: 1,
                    parentId: parentId,
                    reference: item.reference,
                    dataSetRef: item.reference,
                    dataMode: 'polling',
                    nodeType: 'dataset',
                    polldelay: 5000,
                    isDataSet: true,
                    children: []
                };

                this.scanArray.push(treeNode);
                this.pendingTreeParts.push({ data: { ...treeNode, children: [] }, parentid: parentId });

                // Добавляем members как DataObject
                if (item.members && Array.isArray(item.members)) {
                    for (const member of item.members) {
                        const memberRef = member.reference || `${item.reference}.${member.name}`;
                        const memberItem = {
                            reference: memberRef,
                            name: member.name,
                            type: 'dataObject',
                            value: member.value,
                            cdc: member.cdc || "",
                            description: member.description || ''
                        };
                        await this.processDataModelItem(memberItem, itemId);
                    }
                }
                return;
            }

            // ==================== REPORT ====================
            if (this.isReportType(item.type)) {
                const datasetRef = item.datasetRef || item.originalDatasetRef;

                const treeNode = {
                    id: itemId,
                    browseName: item.name,
                    title: itemTitle,
                    nodeClass: 1,
                    parentId: parentId,
                    reference: item.reference,
                    nodeType: item.type.toUpperCase(),
                    reportType: item.reportType || item.type,
                    dataMode: 'report',
                    rcbRef: item.reference,
                    reportId: item.reportId,
                    datasetRef: datasetRef,
                    dataSetRef: datasetRef,
                    originalDatasetRef: item.originalDatasetRef,
                    isReport: true,
                    children: []
                };

                this.scanArray.push(treeNode);
                this.pendingTreeParts.push({ data: { ...treeNode, children: [] }, parentid: parentId });
                return;
            }

            // ==================== DATAOBJECT ====================
            if (item.type?.toLowerCase() === 'dataobject') {
                // Создаём DataObject как контейнер
                const treeNode = {
                    id: itemId,
                    browseName: item.name,
                    title: itemTitle,
                    nodeClass: 1,
                    parentId: parentId,
                    reference: item.reference,
                    nodeType: 'databject',
                    children: []
                };

                this.scanArray.push(treeNode);
                this.pendingTreeParts.push({
                    data: { ...treeNode, children: [] },
                    parentid: parentId
                });

                // Добавляем сам DataObject как лист (для возможности создания канала)
                const doLeafId = itemId + '_DO';
                if (!this.idSet.has(doLeafId)) {
                    this.idSet.add(doLeafId);

                    const channel = {
                        topic: itemTitle,
                        chan: item.reference,
                        title: itemTitle,
                        ref: item.reference,
                        dataType: 'dataObject',
                        accessLevel: 'read',
                        parentfolder: parentFolder,
                        description: item.description || '',
                        cdc: item.cdc || "",
                        r: 1,
                        dataMode: parentFolder.dataMode || 'polling',
                        dataSetRef: parentFolder.dataSetRef
                    };
                    this.plugin.log("CDC " + item.cdc);
                    const doLeaf = {
                        parentId: itemId,
                        id: doLeafId,
                        title: itemTitle,
                        browseName: item.name,
                        nodeClass: 2,
                        nodeType: 'dataObject',
                        reference: item.reference,
                        channel: channel
                    };

                    this.scanArray.push(doLeaf);
                    this.pendingTreeParts.push({ data: doLeaf, parentid: itemId });
                }

                // Рекурсивно обрабатываем детей DataObject
                if (item.children && Array.isArray(item.children)) {
                    for (const child of item.children) {
                        await this.processDataModelItem(child, itemId);
                    }
                }
                return;
            }

            // ==================== DATAATTRIBUTE (ЛИСТ) ====================
            if (this.isLeafType(item.type) || item.type === 'dataAttribute') {
                let displayValue = '';
                if (item.value !== undefined && item.value !== null) {
                    displayValue = ` = ${this.formatValue(item.value)}`;
                }

                const leafTitle = itemTitle + displayValue;

                const channel = {
                    topic: leafTitle,
                    chan: item.reference,
                    title: leafTitle,
                    ref: item.reference,
                    dataType: 'dataAttribute',
                    accessLevel: 'read',
                    parentfolder: parentFolder,
                    description: item.description || '',
                    fc: item.FC || '',
                    r: 1,
                    dataMode: parentFolder.dataMode || 'polling',
                    dataSetRef: parentFolder.dataSetRef
                };

                const leaf = {
                    parentId: parentId,
                    id: itemId,
                    title: leafTitle,
                    browseName: item.name,
                    nodeClass: 2,
                    nodeType: 'dataAttribute',
                    reference: item.reference,
                    channel: channel
                };

                this.scanArray.push(leaf);
                this.pendingTreeParts.push({ data: leaf, parentid: parentId });
                return;
            }

            // ==================== LOGICAL NODE и другие узлы ====================
            if (this.isNodeType(item.type)) {
                const treeNode = {
                    id: itemId,
                    browseName: item.name,
                    title: itemTitle,
                    nodeClass: 1,
                    parentId: parentId,
                    reference: item.reference,
                    nodeType: item.type,
                    children: []
                };

                const hasDataSets = item.dataSets && Array.isArray(item.dataSets) && item.dataSets.length > 0;
                const hasReports = item.reports && Array.isArray(item.reports) && item.reports.length > 0;

                if (hasDataSets) {
                    treeNode.title += ` (${item.dataSets.length} DataSets`;
                    if (hasReports) treeNode.title += `, ${item.reports.length} Reports)`;
                    else treeNode.title += `)`;
                } else if (hasReports) {
                    treeNode.title += ` (${item.reports.length} Reports)`;
                }

                treeNode.childCount = (item.children?.length || 0) + (hasDataSets ? 1 : 0) + (hasReports ? 1 : 0);

                this.scanArray.push(treeNode);
                this.pendingTreeParts.push({ data: { ...treeNode, children: [] }, parentid: parentId });

                // Группы DataSets и Reports
                if (hasDataSets) {
                    const dataSetsGroupId = this.generateNodeId(`${item.reference}.DataSets`, itemId);
                    if (!this.idSet.has(dataSetsGroupId)) {
                        this.idSet.add(dataSetsGroupId);
                        const dataSetsNode = {
                            id: dataSetsGroupId,
                            browseName: 'DataSets',
                            title: 'DataSets',
                            nodeClass: 1,
                            parentId: itemId,
                            reference: `${item.reference}.DataSets`,
                            nodeType: 'dataSetsGroup',
                            childCount: item.dataSets.length
                        };
                        this.scanArray.push(dataSetsNode);
                        this.pendingTreeParts.push({ data: { ...dataSetsNode, children: [] }, parentid: itemId });

                        for (const ds of item.dataSets) {
                            ds.reference = `${item.reference}.${ds.name}`;
                            ds.type = 'dataset';
                            await this.processDataModelItem(ds, dataSetsGroupId);
                        }
                    }
                }

                if (hasReports) {
                    const reportsGroupId = this.generateNodeId(`${item.reference}.Reports`, itemId);
                    if (!this.idSet.has(reportsGroupId)) {
                        this.idSet.add(reportsGroupId);
                        const reportsNode = {
                            id: reportsGroupId,
                            browseName: 'Reports',
                            title: 'Reports',
                            nodeClass: 1,
                            parentId: itemId,
                            reference: `${item.reference}.Reports`,
                            nodeType: 'reportsGroup',
                            childCount: item.reports.length
                        };
                        this.scanArray.push(reportsNode);
                        this.pendingTreeParts.push({ data: { ...reportsNode, children: [] }, parentid: itemId });

                        for (const report of item.reports) {
                            report.type = 'report';
                            await this.processDataModelItem(report, reportsGroupId);
                        }
                    }
                }

                if (item.children && Array.isArray(item.children)) {
                    for (const child of item.children) {
                        await this.processDataModelItem(child, itemId);
                    }
                }
                return;
            }

            this.plugin.log(`Unknown item type: ${item.type || 'undefined'} for ${item.name}`, 2);

        } catch (e) {
            this.plugin.log(`Error processing item ${item.name || item.reference}: ${e.message}`, 2);
        }
    }

    formatValue(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'object') return JSON.stringify(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return String(value);
    }

    async scanExpand(scanObj) {
        this.plugin.log("scanExpand called with: " + util.inspect(scanObj), 1);

        if (!scanObj.parent || !scanObj.parent.reference) {
            this.plugin.log('scanExpand called without valid parent reference', 2);
            return;
        }

        const parentId = scanObj.parent.id;
        const reference = scanObj.parent.reference;
        const nodeType = (scanObj.parent.nodeType || '').toUpperCase();
        const originalTitle = scanObj.parent.title;

        this.plugin.send({
            type: 'scan',
            op: 'update',
            data: { [parentId]: { title: originalTitle + ' (Loading...)' } },
            scanid: 'root'
        });

        this.pendingTreeParts = [];

        try {
            this.plugin.log(`Expanding node: ${reference} (${nodeType})`, 1);

            if (nodeType === 'BR' || nodeType === 'RP' || nodeType === 'REPORT') {
                // === СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ REPORT ===
                await this.expandReport(scanObj.parent);
            }
            else {
                // Обычное сканирование для LN, DO, DataSet и т.д.
                await this.scanning(reference);
            }

            // Восстанавливаем заголовок
            this.plugin.send({
                type: 'scan',
                op: 'update',
                data: { [parentId]: { title: originalTitle } },
                scanid: 'root'
            });

            this.sendAllTreeParts();

            this.plugin.log(`Node ${reference} expanded successfully`, 1);

        } catch (error) {
            this.plugin.log('ERROR in scanExpand: ' + util.inspect(error), 2);
            this.plugin.send({
                type: 'scan',
                op: 'update',
                data: { [parentId]: { title: originalTitle } },
                scanid: 'root'
            });
        }
    }

    /**
     * Специальная обработка раскрытия Report (BR/RP)
     * Загружает DataSet и добавляет его члены как каналы
     */
    async expandReport(reportNode) {
        let dsRef = reportNode.datasetRef ||
            reportNode.originalDatasetRef ||
            reportNode.dataSetRef;

        // Если datasetRef неизвестен — пытаемся получить его через browse
        if (!dsRef) {
            this.plugin.log(`No datasetRef found, browsing report: ${reportNode.reference}`, 1);
            try {
                const reportData = await this.session.browseDataModel(reportNode.reference);
                if (reportData) {
                    dsRef = reportData.datasetRef ||
                        reportData.originalDatasetRef ||
                        reportData.dataSetRef;
                    this.plugin.log(`Found datasetRef: ${dsRef}`, 1);
                }
            } catch (e) {
                this.plugin.log(`Failed to browse report ${reportNode.reference}`, 2);
            }
        }

        if (!dsRef) {
            this.plugin.log(`Cannot expand report ${reportNode.browseName} - no DataSet reference`, 2);
            return;
        }

        this.plugin.log(`Expanding Report → DataSet: ${dsRef}`, 1);

        try {
            const dataModel = await this.session.browseDataModel(dsRef);
            const members = dataModel?.members || dataModel?.children || [];

            this.plugin.log(`DataSet ${dsRef} contains ${members.length} members`, 1);

            // Обновляем информацию о Report
            const updatedReportData = {
                datasetRef: dsRef,
                dataSetRef: dsRef,
                childCount: members.length,
                title: reportNode.title.replace(/ \(\d+ members?\)?$/, '') + ` (${members.length} members)`
            };

            // Обновляем узел в scanArray
            const reportInArray = this.scanArray.find(n => n.id === reportNode.id);
            if (reportInArray) {
                Object.assign(reportInArray, updatedReportData);
            }

            // Отправляем обновление в интерфейс
            this.plugin.send({
                type: 'scan',
                op: 'update',
                data: { [reportNode.id]: updatedReportData },
                scanid: 'root'
            });

            // === Добавляем члены DataSet как каналы ===
            for (const member of members) {
                const memberRef = member.reference || `${dsRef}.${member.name}`;

                const memberItem = {
                    reference: memberRef,
                    name: member.name,
                    type: 'dataObject',           
                    value: member.value,
                    description: member.description || '',
                    // Дополнительная информация
                    cdc: member.cdc || '',
                    typeDescription: member.type || ''
                };

                await this.processDataModelItem(memberItem, reportNode.id);
            }

            this.plugin.log(`Successfully added ${members.length} members from DataSet ${dsRef}`, 1);

        } catch (e) {
            this.plugin.log(`Error expanding DataSet ${dsRef}: ${e.message}`, 2);
            this.plugin.log(util.inspect(e), 2);
        }
    }

    getItemTitle(item) {
        let title = item.name;

        switch (item.type?.toLowerCase()) {
            case 'logicalnode':
                title += ' (LN)';
                break;
            case 'dataobject':
                title += ' (DO)';
                break;
            case 'dataset':
                title += ' (DS)';
                break;
            case 'dataattribute':
                title += ' (DA)';
                break;
            case 'br':
                title += ' (BR)';
                break;
            case 'rp':
                title += ' (RP)';
                break;
            default:
                if (item.type) title //+= ` (${item.type})`;
        }

        return title;
    }
    
    /**
     * Определяет, является ли DataObject "листовым" (можно создавать канал)
     * Или это контейнер, который нужно раскрывать дальше
     */
    isLeafLikeDataObject(item) {
        if (!item || !item.children || !Array.isArray(item.children)) {
            return true; // если нет детей — точно лист
        }

        const childNames = item.children.map(ch => (ch.name || '').toLowerCase());

        // Если среди детей есть q и t — считаем листом
        if (childNames.includes('q') && childNames.includes('t')) {
            return true;
        }

        // Типичные "листовые" атрибуты
        const leafIndicators = ['stval', 'mag', 'ang', 'f', 'i', 'boolean', 'integer', 'float'];
        return childNames.some(name => leafIndicators.some(ind => name.includes(ind)));
    }

    sendAllTreeParts() {
        if (this.pendingTreeParts.length === 0) return;

        this.plugin.log(`Sending ${this.pendingTreeParts.length} tree parts`, 1);

        for (const part of this.pendingTreeParts) {
            this.sendTreePart(part.data, part.parentid);
        }

        this.pendingTreeParts = [];
    }

    sendTreePart(data, parentid) {
        this.plugin.send({
            type: 'scan',
            op: 'add',
            data: data,
            parentid: parentid,
            scanid: 'root'
        });
    }

    sendTree(uuid, data) {
        if (!data) data = [this.makeTree()];
        this.plugin.send({ type: 'scan', op: 'list', data, uuid });
    }

    makeTree() {
        const ids = this.scanArray.reduce((acc, el, i) => {
            acc[el.id] = i;
            return acc;
        }, {});

        let root = null;
        this.scanArray.forEach(el => {
            if (!el.parentId || el.parentId === '') {
                root = el;
                return;
            }
            const parentEl = this.scanArray[ids[el.parentId]];
            if (parentEl) {
                if (!parentEl.children) parentEl.children = [];
                parentEl.children.push(el);
            }
        });

        return root || this.scanArray[0];
    }

    generateNodeId(reference, parentId = '') {
        if (!reference) {
            return 'unknown_' + Math.random().toString(36).substr(2, 8);
        }

        let id = reference.replace(/[^a-zA-Z0-9_\-./$]/g, '_');

        // Для dataAttribute (листьев) делаем ID уникальным по родителю
        // Это решает проблему, когда один DataSet используется в нескольких Reports
        if (parentId && parentId !== 'RootFolder') {
            const lowerType = (reference || '').toLowerCase();
            if (lowerType.includes('[') || lowerType.includes('$') || lowerType.includes('stval') ||
                lowerType.includes('mag') || lowerType.includes('ang')) {   // признаки DataAttribute

                // Используем parentId (который у Report'а уникальный) + reference
                const parentHash = parentId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(-60);
                id = `${parentHash}__${id}`;
            }
        }

        return id;
    }

    getClientID() {
        return this.clientID;
    }

    stop() {
        this.clients.clear();
        this.idSet.clear();
        this.scanArray = [];
        this.pendingTreeParts = [];
        this.clientID = '';
        this.status = 0;
        this.session = null;
        this.plugin.log('Scanner stopped', 1);
    }
}

module.exports = Scanner;