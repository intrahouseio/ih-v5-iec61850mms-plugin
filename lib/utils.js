/**
 * Вспомогательные утилиты
 */

/**
 * Извлекает значение из объекта по пути
 * @param {Object} obj - Исходный объект
 * @param {string} path - Путь к значению (например: 'stVal', 'Oper.ctlVal', 'mag.f')
 * @returns {any} - Найденное значение или undefined
 */
function extractValue(obj, path) {
    if (!obj || typeof obj !== 'object') {
        return undefined;
    }

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }
        current = current[part];
    }

    return current;
}

/**
 * Отправка данных каналов на сервер
 * @param {Object} plugin - Объект плагина
 * @param {Array} channelsData - Массив данных каналов
 */
function sendChannelData(plugin, channelsData) {
    const ts = Date.now();
    const dataArray = channelsData.map(({ id, value, chstatus = 0 }) => ({
        id,
        value,
        ts,
        chstatus
    }));

    plugin.sendData(dataArray);
    plugin.log(`Sent ${dataArray.length} channel values`, 1);
}

/**
 * Создает задержку
 * @param {number} ms - Время задержки в миллисекундах
 * @returns {Promise} - Promise, который разрешается после задержки
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Проверяет валидность параметров подключения
 * @param {Object} params - Параметры плагина
 * @returns {Object} - Объект с ошибкой или null
 */
function validateParams(params) {
    const { ip, port } = params;

    if (!ip || typeof ip !== 'string') {
        return { error: 'Invalid IP address' };
    }

    const portNum = parseInt(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return { error: `Invalid port: ${port}` };
    }

    return null;
}

/**
 * Определяет путь к значению на основе типа данных IEC 61850
 * @param {string} dataRef - Ссылка на данные (например: 'WAGO61850ServerDevice/GGIO1.Mod[ST]')
 * @returns {string} - Путь к значению
 */
function determineValuePath(dataRef) {
    if (!dataRef) return 'stVal';
    
    if (dataRef.includes('[ST]')) {
        return 'stVal';
    } else if (dataRef.includes('[MX]')) {
        return 'mag.f';
    } else if (dataRef.includes('[CO]')) {
        return 'Oper.ctlVal';
    } else if (dataRef.includes('[CF]')) {
        return 'ctlModel';
    } else if (dataRef.includes('[DC]')) {
        return 'd';
    } else {
        return 'stVal'; // default
    }
}

module.exports = {
    extractValue,
    sendChannelData,
    delay,
    validateParams,
    determineValuePath
};