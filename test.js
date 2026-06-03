const { MmsClient } = require('@amigo9090/ih-libiec61850-node');
const util = require('util');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let counter = 0;

function incrementCounter() {
    counter++;
    console.log('Current count: ' + counter);
}

// Start the interval, calls incrementCounter every 1000ms (1 second)
let intervalId = setInterval(incrementCounter, 1000);
const client = new MmsClient(async (event, data) => {
    //console.log(`Event: ${event}, Data: ${util.inspect(data, { depth: null })}`);

    if (event === 'conn' && data.event === 'opened') {
        console.log("Browse data model")
        const dataModel = await client.browseDataModel("WAGO61850ServerDevice/LLN0.RP$ReportBlock0301");
                console.log('Data Model:', util.inspect(dataModel, { depth: null }));
        
                // Извлечение всех датасетов
                /*const dataSets = [];
                dataModel.forEach(ld => {
                    ld.logicalNodes.forEach(ln => {
                        ln.dataSets.forEach(ds => {
                            console.log(`Found dataset: ${ds.reference}`);
                            dataSets.push(ds);
                        });
                    });
                });*/
        // Чтение одиночного DataSet:
        const readModelResults = await client.readDataSetModel(['WAGO61850ServerDevice/LLN0.DataSet02']);
        // const readModelResults = await client.browseDataModel('WAGO61850ServerDevice/LLN0.DataSet01');
        // Пакетное чтение данных
        console.log('readDataSetModel ' + util.inspect(readModelResults, null, 5));
        const dataRefs = [
            'WAGO61850ServerDevice/XCBR1.Pos',
            'WAGO61850ServerDevice/GGIO1.Mod',
            'WAGO61850ServerDevice/CALH15.GrAlm'
        ];

        //const readRefResult = await client.readData(dataRefs); 
        //console.log(Date.now() +" readRefResultTimeStart ")
        const pollResults = await client.pollDataSetValues(['WAGO61850ServerDevice/LLN0.DataSet02']);
        console.log(Date.now() + ' readDataSetResults ' + util.inspect(pollResults, null, 5));
        // Включение отчётов
        const rcbRef = 'WAGO61850ServerDevice/LLN0.RP.ReportBlock0101';
        const dataSetRef = 'WAGO61850ServerDevice/LLN0.DataSet03';
        //console.log(`Enabling reporting for ${rcbRef} with dataset ${dataSetRef}`);
        //client.enableReporting(rcbRef, dataSetRef);

    }

    if (event === 'data' && data.type === 'data') {
        if (data.event === 'logicalDevices') {
            console.log(`Logical Devices received: ${util.inspect(data.logicalDevices, { depth: null })}`);
        } else if (data.event === 'dataSetDirectory') {
            console.log(`DataSet Directory for ${data.logicalNodeRef}: ${util.inspect(data.dataSets, { depth: null })}`);
        } else if (data.event === 'dataModel') {
            console.log(`Data Model received: ${util.inspect(data.dataModel, { depth: null })}`);
        } else if (data.event === 'dataSet') {
            // Одиночный DataSet (обратная совместимость)
            console.log(`DataSet received for ${data.datasetRef}: ${util.inspect(data.value, { depth: null })}`);
        } else if (data.event === 'multipleDataSets') {
            // Множественные DataSet
            console.log(`Multiple DataSets received for ${util.inspect(data.datasetRefs, { depth: null })}:`);
            data.values.forEach((value, index) => {
                if (value.isValid !== false) {
                    console.log(`  DataSet[${index}]: ${data.datasetRefs[index]}, Value: ${util.inspect(value, { depth: null })}`);
                } else {
                    console.log(`  DataSet[${index}]: ${data.datasetRefs[index]}, Error: ${value.errorReason}`);
                }
            });
        } else if (data.event === 'report') {
            console.log('Report data ' + util.inspect(data))
            console.log(`Report received for ${data.rcbRef} (rptId: ${data.rptId}):`);
            if (data.timestamp) {
                console.log(`  Timestamp: ${data.timestamp}`);
            }
            Object.keys(data.values).forEach(key => {
                console.log(`${key} | val: ${JSON.stringify(data.values[key])} | reason: ${data.reasons[key]}`);
            });
        } else if (data.event === 'batchData') {
            console.log(`Batch Data received for ${util.inspect(data.dataRefs, { depth: null })}:`);
            Object.keys(data.values).forEach(key => {
                console.log(`${key} | val: ${JSON.stringify(data.values[key])} | reason: ${data.reasons[key]}`);
            });
        } else {
            console.log(`Data received for ${data.dataRef || 'undefined'}: ${util.inspect(data.value, { depth: null })}`);
        }
    }

    if (event === 'data' && data.type === 'error') {
        console.error(`Error received: ${data.reason}`);
    }

    if (event === 'conn' && data.event === 'reconnecting') {
        console.error(`Reconnection failed: ${data.reason}`);
        if (data.reason.includes('attempt 3')) {
            throw new Error('Max reconnection attempts reached');
        }
    }

    if (event === 'data' && data.type === 'control') {
        if (data.event === 'reportingEnabled') {
            console.log(`Reporting enabled for ${data.rcbRef}`);
        } else if (data.event === 'reportingDisabled') {
            console.log(`Reporting disabled for ${data.rcbRef}`);
        } else if (data.event === 'dataSetCreated') {
            console.log(`DataSet created: ${data.datasetRef}`);
        } else if (data.event === 'dataSetDeleted') {
            console.log(`DataSet deleted: ${data.datasetRef}`);
        } else if (data.event === 'stateChanged') {
            console.log(`Connection state changed: ${data.state}, isConnected: ${data.isConnected}`);
        }
    }

    if (event === 'conn' && data.event === 'stateChanged') {
        console.log(`Connection state changed: ${data.state}, isConnected: ${data.isConnected}`);
    }
});

async function main() {


    try {
        console.log('Starting client...');
        await client.connect({
            ip: '176.193.75.143',
            port: 102,
            clientID: 'mms_client1',
            reconnectDelay: 2
        });
        await sleep(5000);

        // console.log('And now we try do control operation!!!!!!!!!!!!!!!...');
        // client.controlObject("WAGO61850ServerDevice/XCBR1.Pos", true);

        // Дополнительное ожидание для обработки операции управления
        // await sleep(5000);

        // Ожидание обработки данных и отчетов
        console.log('Waiting for data and reports...');
        await sleep(30000);

        // Отключение отчетов
        const rcbRef = 'WAGO61850ServerDevice/LLN0.RP.ReportBlock0101';
        console.log(`Disabling reporting for ${rcbRef}`);
        client.disableReporting(rcbRef);

        console.log('Client status:', client.getStatus());

        console.log('Closing client...');
        await client.close();
        console.log('Client closed.');
    } catch (err) {
        console.error('Main error:', err.message);
        await client.close().catch(e => console.error('Close error:', e.message));
    }
}

main().catch(err => console.error('Fatal error:', err.message));