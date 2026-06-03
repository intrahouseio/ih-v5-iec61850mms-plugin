const { MmsClient } = require('@amigo9090/ih-libiec61850-node');
const util = require('util');

// Глобальные переменные для управления периодическим чтением
let periodicReadActive = false;
let readInterval = 2000; // Интервал чтения в миллисекундах (2 секунды)
let isConnected = false; // Флаг состояния подключения

// Списки для чтения
const dataSetRefs = [
    'WAGO61850ServerDevice/LLN0.DataSet01',
  //  'WAGO61850ServerDevice/LLN0.DataSet02' // добавьте нужные датасеты
];

const individualDataRefs = [
    'WAGO61850ServerDevice/XCBR1.Pos',
    'WAGO61850ServerDevice/GGIO1.Mod',
    'WAGO61850ServerDevice/CALH15.GrAlm'
];

const client = new MmsClient(async (event, data) => {
    console.log(`Event: ${event}, Data: ${util.inspect(data, { depth: null })}`);

    if (event === 'conn') {
        if (data.event === 'opened') {
            console.log('Connection opened. Starting periodic reading...');
            isConnected = true;
            // Запускаем периодическое чтение после подключения
            startPeriodicRead();
            
            // Включение отчётов
            const rcbRef = 'WAGO61850ServerDevice/LLN0.RP.ReportBlock0101';
            const dataSetRef = 'WAGO61850ServerDevice/LLN0.DataSet02';
            // console.log(`Enabling reporting for ${rcbRef} with dataset ${dataSetRef}`);
             client.enableReporting(rcbRef, dataSetRef);
        }
        else if (data.event === 'closed') {
            console.log('Connection closed. Stopping periodic reading...');
            isConnected = false;
            stopPeriodicRead();
        }
        else if (data.event === 'stateChanged') {
            console.log(`Connection state changed: ${data.state}, isConnected: ${data.isConnected}`);
            isConnected = data.isConnected;
            if (!data.isConnected) {
                stopPeriodicRead();
            }
        }
        else if (data.event === 'reconnecting') {
            console.error(`Reconnection failed: ${data.reason}`);
            if (data.reason.includes('attempt 3')) {
                console.error('Max reconnection attempts reached');
                isConnected = false;
                stopPeriodicRead();
            }
        }
    }

    if (event === 'data' && data.type === 'data') {
        if (data.event === 'report') {
            console.log(`Report received for ${data.rcbRef} (rptId: ${data.rptId}):`);
            if (data.timestamp) {
                console.log(`  Timestamp: ${data.timestamp}`);
            }
            data.values.forEach((value, index) => {
                if (data.reasonsForInclusion[index] !== 0) {
                    console.log(`  Value[${index}]: ${util.inspect(value, { depth: null })}, Reason: ${data.reasonsForInclusion[index]}`);
                }
            });
        } else if (data.event === 'batchData') { 
            console.log(`Batch Data received for ${util.inspect(data.dataRefs, { depth: null })}:`);
            data.values.forEach((result, index) => {
                if (result.isValid) {
                    console.log(`  dataRef[${index}]: ${data.dataRefs[index]}, Value: ${util.inspect(result.value, { depth: null })}`);
                } else {
                    console.log(`  dataRef[${index}]: ${data.dataRefs[index]}, Error: ${result.errorReason}`);
                }
            });
        }
        // Обработка других событий данных...
    }

    if (event === 'data' && data.type === 'error') {
        console.error(`Error received: ${data.reason}`);
    }
});

// Функция для чтения DataSet
async function readDataSetSequentially() {
    console.log(`[${new Date().toISOString()}] Starting sequential DataSet reading...`);
  const model = await client.readDataSetModel(dataSetRefs[0]);
  console.log("model ", model)
    // Последовательно читаем каждый DataSet
    for (let i = 0; i < dataSetRefs.length; i++) {
        const dataSetRef = dataSetRefs[i];
        try {
            console.log(`[${new Date().toISOString()}] Reading DataSet: ${dataSetRef}`);
            const startTime = Date.now();
            //const readResults = await client.pollDataSetValues(dataSetRef);
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            console.log(`[${new Date().toISOString()}] DataSet ${dataSetRef} read result (took ${duration}ms):`);
            console.log(util.inspect(readResults, { depth: null, colors: true, maxArrayLength: 10 }));
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error reading DataSet ${dataSetRef}:`, error.message);
        }
        
        // Небольшая пауза между чтениями DataSet
        if (i < dataSetRefs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

// Функция для чтения индивидуальных данных
async function readIndividualData() {
    console.log(`[${new Date().toISOString()}] Reading individual data...`);
    
    try {
        const startTime = Date.now();
        const readResult = await client.readData(individualDataRefs);
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        console.log(`[${new Date().toISOString()}] Individual data read result (took ${duration}ms):`);
        readResult.forEach((result, index) => {
            if (result.isValid) {
                console.log(`  ${individualDataRefs[index]}: ${util.inspect(result.value, { depth: null })}`);
            } else {
                console.error(`  ${individualDataRefs[index]}: Error - ${result.errorReason}`);
            }
        });
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error reading individual data:`, error.message);
    }
}

// Главная функция циклического чтения
async function performCyclicReadings() {
    console.log(`[${new Date().toISOString()}] === Starting cyclic reading cycle ===`);
    
    // 1. Читаем DataSet последовательно
    await readDataSetSequentially();
    
    // 2. Читаем индивидуальные данные
    await readIndividualData();
    
    console.log(`[${new Date().toISOString()}] === Finished cyclic reading cycle ===\n`);
}

// Функция для периодического чтения данных с использованием setTimeout
async function startPeriodicRead() {
    if (periodicReadActive) {
        console.log('Periodic reading already active');
        return;
    }
    
    periodicReadActive = true;
    console.log('Starting periodic data reading...');
    
    // Запускаем первый вызов
    scheduleNextRead();
}

// Рекурсивная функция для планирования следующего чтения
function scheduleNextRead() {
    if (!periodicReadActive) {
        return;
    }
    
    setTimeout(async () => {
        if (!periodicReadActive) {
            return;
        }
        
        try {
            // Проверяем состояние подключения через флаг
            if (!isConnected) {
                console.log('Client not connected (from callback), skipping periodic read');
                // Планируем следующую попытку
                if (periodicReadActive) {
                    scheduleNextRead();
                }
                return;
            }
            
            // Выполняем цикл чтений
            await performCyclicReadings();
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error during periodic read cycle:`, error.message);
        }
        
        // Планируем следующий вызов независимо от результата
        if (periodicReadActive) {
            scheduleNextRead();
        }
    }, readInterval);
}

// Функция для остановки периодического чтения
function stopPeriodicRead() {
    if (periodicReadActive) {
        periodicReadActive = false;
        console.log('Periodic data reading stopped.');
    }
}

async function main() {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
        console.log('Starting client...');
        await client.connect({
            ip: '176.193.75.143',
            port: 102,
            clientID: 'mms_client1',
            reconnectDelay: 2
        });
        
        // Ожидание обработки данных и отчетов
        console.log('Waiting for data and reports...');
        await sleep(30000);
        
        // Остановка периодического чтения перед отключением отчетов
        stopPeriodicRead();

        // Отключение отчетов
        const rcbRef = 'WAGO61850ServerDevice/LLN0.RP.ReportBlock0101';
        console.log(`Disabling reporting for ${rcbRef}`);
        client.disableReporting(rcbRef);

        console.log('Closing client...');
        await client.close();
        console.log('Client closed.');
    } catch (err) {
        console.error('Main error:', err.message);
        // Останавливаем таймер в случае ошибки
        stopPeriodicRead();
        await client.close().catch(e => console.error('Close error:', e.message));
    }
}

// Обработка завершения приложения
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Shutting down...');
    stopPeriodicRead();
    await client.close().catch(e => console.error('Close error:', e.message));
    process.exit(0);
});

main().catch(err => console.error('Fatal error:', err.message));