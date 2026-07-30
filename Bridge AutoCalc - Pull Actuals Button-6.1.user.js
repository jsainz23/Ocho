// ==UserScript==
// @name         Bridge AutoCalc - Pull Actuals Button
// @namespace    https://tampermonkey.net/
// @version      6.1
// @description  Adds a Pull Actuals button to Bridge AutoCalc and fills Combined Cartons using FCLM and iGraph logic. Also silently captures NVF/TI Backlog Days from the SandOp NetworkViewer page via a hidden iframe (no manual navigation needed).
// @author       sainzjon (Jonathon Sainz)
// @match        https://drive-render.corp.amazon.com/view/*/Bridge_AutoCalc.html*
// @match        https://portal.sandop.a2z.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fclm-portal.amazon.com
// @connect      monitorportal.amazon.com
// @connect      scheduling.amazon.com
// @connect      neo.meta.amazon.dev
// @connect      portal.sandop.a2z.com
// @connect      sandop.a2z.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const FIELD_MAP = {
        uis5Rate:        'b18',
        uis20Rate:       'b19',
        mansortRate:     'b20',
        uis5Hours:       'b22',
        uis20Hours:      'b23',
        mansortHours:    'b24',
        vtoActual:       'b11',
        vtoPlan:         'c11',
        vetActual:       'b10',
        vetPlan:         'c10',
        totalHours:      'b9',
        sortUnits:       'b15',
        presortCases:    'b16',
        combinedCartons: 'b2',
        pidCartons: 'b3',
        palletReceive: 'b4',
        tiPidCartons: 'b5',
        throughputCPLH: 'b12',
        throughputCPLH2: 'b26',
        neoPlannedHours: 'c9',
        nvfBacklogDays: 'bl_nvf',
        tiBacklogDays: 'bl_ti'
    };

    const PPR_CSV_ROW_MAPPINGS = {
        'ppr.fcSummary.throughput': 'actualThroughputHours',
        'ppr.detail.inbound.transferInAndStow.palletTransferIn': 'transInPallets',
        'ppr.detail.inbound.receive.palletReceive': 'receivePallets'
    };

    const DA_VALID_JOB_ACTIONS = [
        'FluidLoadCase', 'ScanCaseToPallet', 'FluidLoadTote',
        'ScanToteToPallet', 'TransshipPalletVerified'
    ];

    const DA_TRANSFER_OUT_PROCESS_IDS = [1003021, 1002985, 1003022, 1003023, 1003018];

    const PROCESS_IDS = {
        PALLET_RECEIVE: [1003032, 1003010, 1002980, 1003002, 1002982, 1003041],
        TRANS_IN: [1003035]
    };

    const SORT_PROCESS_ID = 1003009;

    const SORT_TABLE_IDS = {
        uis5:    ['function-1588886488518', 'function-1748942467646'],
        uis20:   ['function-1588886757628', 'function-1748942479650'],
        mansort: ['function-4300006775',    'function-4300006777']
    };

    // NEO Planning API — site-level constants
    const NEO_PLAN_PARAMS = {
        staffing_profile_id: 84,
        department:          'One Flow',
        plan_name:           'sos'
    };

    // NEO plan IDs per shift for ONT8 SOS plan.
    // Check Network tab on neo.meta.amazon.dev/planning (generate_plan URL) if IDs rotate.
    const NEO_PLAN_IDS = {
        day:   351611,   // confirmed 2026-04-10
        night: 352225    // confirmed 2026-04-10
    };

    // NEO_SHIFT_IDS removed — shift_ids are now resolved dynamically via /shift endpoint per date

    const EXCLUDED_IGRAPH_METRICS = [
        'prEditorTransIn', 'totalTransInCartons', 'pidNVF',
        'manual', 'cPrEditorNVF', 'pidTransIn'
    ];

    const STARTUP_DELAY = 1500;
    const IGRAPH_DATA_START_ROW = 6;

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getEl(id) {
        return document.getElementById(id);
    }

    function getInputValue(id) {
        return getEl(id)?.value?.trim() || '';
    }

    function setInputValue(id, value) {
        const el = getEl(id);
        if (!el) return;
        el.value = value ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function showToast(message, isError = false) {
        let toast = document.getElementById('tm-bridge-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'tm-bridge-toast';
            toast.style.cssText = `
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 99999;
                padding: 10px 14px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                box-shadow: 0 4px 12px rgba(0,0,0,.2);
                transition: opacity .2s ease;
                opacity: 0;
                background: ${isError ? '#7f1d1d' : '#14532d'};
                color: #fff;
            `;
            document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.style.background = isError ? '#7f1d1d' : '#14532d';
        toast.style.opacity = '1';

        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.style.opacity = '0';
        }, 3000);
    }

    function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }

        result.push(current.trim());
        return result;
    }

    function parseCSVText(csvText) {
        return csvText.split('\n').filter(line => line.trim() !== '');
    }

    function getWarehouseId() {
        return 'ONT8';
    }

    function buildBridgeDateTime() {
        const reportDate = getInputValue('report-date');
        const shiftStart = getInputValue('shift-start') || '00:00';
        const shiftEnd = getInputValue('shift-end') || '00:00';

        const [y, m, d] = reportDate.split('-');
        const startDateRaw = `${y}/${m}/${d}`;

        const [sh, sm] = shiftStart.split(':').map(Number);
        const [eh, em] = shiftEnd.split(':').map(Number);

        const fullDay = sh === eh && sm === em;

        let endDateObj = new Date(`${reportDate}T00:00:00`);
        if (fullDay || (eh < sh || (eh === sh && em < sm))) {
            endDateObj.setDate(endDateObj.getDate() + 1);
        }

        const endY = endDateObj.getFullYear();
        const endM = String(endDateObj.getMonth() + 1).padStart(2, '0');
        const endD = String(endDateObj.getDate()).padStart(2, '0');
        const endDateRaw = `${endY}/${endM}/${endD}`;

        return {
            startDateString: `${y}%2F${m}%2F${d}`,
            endDateString: `${endY}%2F${endM}%2F${endD}`,
            startHour: String(sh),
            startMinute: String(sm),
            endHour: String(eh),
            endMinute: String(em),
            startDateRaw,
            endDateRaw
        };
    }

    function buildFunctionRollupUrl(warehouseId, processId, dt) {
        return `https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=CSV&warehouseId=${warehouseId}&processId=${processId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${dt.startDateString}&startHourIntraday=${dt.startHour}&startMinuteIntraday=${dt.startMinute}&endDateIntraday=${dt.endDateString}&endHourIntraday=${dt.endHour}&endMinuteIntraday=${dt.endMinute}`;
    }

    function gmRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Accept': 'application/json, text/plain, */*'
                },
                timeout: 30000,
                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        console.error(`[Bridge AutoCalc] HTTP ${response.status} body:`, response.responseText);
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('Request failed')),
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    function gmPostRequest(url, payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: 30000,
                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('Request failed')),
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    async function fetchFclmRows(url) {
        const text = await gmRequest(url);
        const lines = parseCSVText(text);
        if (!lines.length) return [];

        const headers = parseCSVLine(lines[0]);
        return lines.slice(1).map(line => {
            const values = parseCSVLine(line);
            const row = {};
            headers.forEach((header, idx) => {
                row[header] = values[idx] || '';
            });
            return row;
        });
    }

    async function scrapeFclmCombinedCartons(dt, warehouseId) {
        const prUrls = PROCESS_IDS.PALLET_RECEIVE.map(id => buildFunctionRollupUrl(warehouseId, id, dt));
        const tiUrls = PROCESS_IDS.TRANS_IN.map(id => buildFunctionRollupUrl(warehouseId, id, dt));

        const prResults = await Promise.all(prUrls.map(fetchFclmRows));
        const tiResults = await Promise.all(tiUrls.map(fetchFclmRows));

        const prData = prResults.flat();
        const tiData = tiResults.flat();

        let palletReceive = 0;
        let transInCase = 0;
        let transInTote = 0;

        prData.forEach(row => {
            if (row['Size'] === 'Total' && row['Unit Type'] === 'Case' && row['Job Action'] === 'PalletReceived') {
                palletReceive += parseInt(row['Units'], 10) || 0;
            }
        });

        tiData.forEach(row => {
            if (row['Size'] === 'Total' && row['Function Name'] === 'Case Transfer In') {
                if (row['Unit Type'] === 'Case' && row['Job Action'] === 'CaseReceived') {
                    transInCase += parseInt(row['Jobs'], 10) || 0;
                }
                if (row['Unit Type'] === 'Tote' && row['Job Action'] === 'ToteReceived') {
                    transInTote += parseInt(row['Jobs'], 10) || 0;
                }
            }
        });

        return {
            palletReceive,
            transInCase,
            transInTote,
            tiPidCartons: transInCase + transInTote
        };
    }

    function convertLocalToUTC(hour, minute, dateRaw) {
        const parts = dateRaw.split('/').map(Number);
        let year;
        let month;
        let day;

        if (String(parts[0]).length === 4) {
            [year, month, day] = parts;
        } else {
            [month, day, year] = parts;
        }

        const localDate = new Date(year, month - 1, day, hour, minute, 0);

        return {
            date: `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`,
            hour: localDate.getUTCHours(),
            minute: localDate.getUTCMinutes()
        };
    }

    async function scrapeIGraphCombinedCartons(dt, warehouseId) {
        const startUtc = convertLocalToUTC(parseInt(dt.startHour, 10), parseInt(dt.startMinute, 10), dt.startDateRaw);
        const endUtc = convertLocalToUTC(parseInt(dt.endHour, 10), parseInt(dt.endMinute, 10), dt.endDateRaw);

        const startTime = `${startUtc.date}T${String(startUtc.hour).padStart(2, '0')}%3A${String(startUtc.minute).padStart(2, '0')}%3A00Z`;
        const endTime = `${endUtc.date}T${String(endUtc.hour).padStart(2, '0')}%3A${String(endUtc.minute).padStart(2, '0')}%3A00Z`;

        const url = `https://monitorportal.amazon.com/mws?Action=GetGraph&Version=2007-07-07&SchemaName1=Service&DataSet1=Prod&Marketplace1=${warehouseId}&HostGroup1=ALL&Host1=ALL&ServiceName1=AFTCartonDataService&MethodName1=CreateCartonFromFreightLabel&Client1=ALL&MetricClass1=NONE&Instance1=NONE&Metric1=CartonEventPublish.Created&Period1=FiveMinute&Stat1=sum&Label1=AFTCartonDataService%20CreateCartonFromFreightLabel%20NONE%20NONE%20CartonEventPublish.Created&SchemaName2=Service&ServiceName2=AFTInboundDirectorService&MethodName2=PendingCartonLockSQSConsumer&MetricClass2=HANDSCANNER&Instance2=ALL&Metric2=FirstPerformanceForCarton&Label2=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20HANDSCANNER%20ALL%20FirstPerformanceForCarton&SchemaName3=Service&MetricClass3=UNKNOWN&Label3=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20UNKNOWN%20ALL%20FirstPerformanceForCarton&SchemaName4=Service&MetricClass4=PID&Label4=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20PID%20ALL%20FirstPerformanceForCarton&SchemaName5=Service&MetricClass5=AROS&Label5=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20AROS%20ALL%20FirstPerformanceForCarton&SchemaName6=Service&MetricClass6=MARS&Label6=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20MARS%20ALL%20FirstPerformanceForCarton&SchemaName7=Service&MetricClass7=HANDSCANNER&Metric7=FirstPerformanceForTransInCarton&Label7=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20HANDSCANNER%20ALL%20FirstPerformanceForTransInCarton&SchemaName8=Service&MetricClass8=UNKNOWN&Label8=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20UNKNOWN%20ALL%20FirstPerformanceForTransInCarton&SchemaName9=Service&MetricClass9=PID&Label9=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20PID%20ALL%20FirstPerformanceForTransInCarton&SchemaName10=Service&MetricClass10=AROS&Label10=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20AROS%20ALL%20FirstPerformanceForTransInCarton&SchemaName11=Service&MetricClass11=MARS&Label11=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20MARS%20ALL%20FirstPerformanceForTransInCarton&HeightInPixels=250&WidthInPixels=600&GraphTitle=Cartons%20Created&DecoratePoints=true&GraphType=pie&TZ=UTC@TZ%3A%20UTC&StartTime1=${startTime}&EndTime1=${endTime}&FunctionExpression1=M1&FunctionLabel1=Manual&FunctionYAxisPreference1=left&FunctionColor1=default&FunctionExpression2=SUM%28M2%2C%20M3%29&FunctionLabel2=cPrEditor%20NVF&FunctionYAxisPreference2=left&FunctionColor2=default&FunctionExpression3=M4&FunctionLabel3=PID%20NVF&FunctionYAxisPreference3=left&FunctionColor3=default&FunctionExpression4=SUM%28M1%2CM2%2CM3%2CM4%2CM5%2CM6%29&FunctionLabel4=Total%20NVF%20Cartons&FunctionYAxisPreference4=right&FunctionColor4=default&FunctionExpression5=M5&FunctionLabel5=AROS%20NVF&FunctionYAxisPreference5=left&FunctionColor5=default&FunctionExpression6=M6&FunctionLabel6=MARS%20NVF&FunctionYAxisPreference6=left&FunctionColor6=default&FunctionExpression7=SUM%28M7%2CM8%29&FunctionLabel7=PrEditor%20TransIn&FunctionYAxisPreference7=left&FunctionColor7=default&FunctionExpression8=M9&FunctionLabel8=PID%20TransIn&FunctionYAxisPreference8=left&FunctionColor8=default&FunctionExpression9=M10&FunctionLabel9=AROS%20TransIn&FunctionYAxisPreference9=left&FunctionColor9=default&FunctionExpression10=M11&FunctionLabel10=MARS%20TransIn&FunctionYAxisPreference10=left&FunctionColor10=default&FunctionExpression11=SUM%28M7%2CM8%2CM9%2CM10%2CM11%29&FunctionLabel11=Total%20TransIn%20Cartons&FunctionYAxisPreference11=right&FunctionColor11=default&OutputFormat=CSV_TRANSPOSE`;

        const csvText = await gmRequest(url);
        const lines = parseCSVText(csvText);
        if (!lines.length) {
            return { totalNVFCartons: 0 };
        }

        const headers = parseCSVLine(lines[0]);
        const cartonData = {
            arosNVF: 0,
            arosTransIn: 0,
            cPrEditorNVF: 0,
            manual: 0,
            marsNVF: 0,
            marsTransIn: 0,
            pidNVF: 0,
            pidTransIn: 0,
            prEditorTransIn: 0,
            totalNVFCartons: 0,
            totalTransInCartons: 0
        };

        const headerMap = [
            [/AROS NVF/i, 'arosNVF'],
            [/AROS TransIn/i, 'arosTransIn'],
            [/cPrEditor NVF/i, 'cPrEditorNVF'],
            [/Manual/i, 'manual'],
            [/MARS NVF/i, 'marsNVF'],
            [/MARS TransIn/i, 'marsTransIn'],
            [/PID NVF/i, 'pidNVF'],
            [/PID TransIn/i, 'pidTransIn'],
            [/PrEditor TransIn/i, 'prEditorTransIn'],
            [/Total NVF Cartons/i, 'totalNVFCartons'],
            [/Total TransIn Cartons/i, 'totalTransInCartons']
        ];

        for (let i = IGRAPH_DATA_START_ROW; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            headers.forEach((header, idx) => {
                if (header === 'Id' || /UTC|Time/i.test(header)) return;
                const val = parseFloat(values[idx]) || 0;
                if (val <= 0) return;

                for (const [regex, key] of headerMap) {
                    if (regex.test(header)) {
                        cartonData[key] += val;
                        break;
                    }
                }
            });
        }

        const filtered = {};
        Object.entries(cartonData).forEach(([key, value]) => {
            if (value > 0 && !EXCLUDED_IGRAPH_METRICS.includes(key)) {
                filtered[key] = value;
            }
        });

        return {
            totalNVFCartons: filtered.totalNVFCartons || 0
        };
    }

    async function scrapeDATransferOut(dt, warehouseId) {
        const urls = DA_TRANSFER_OUT_PROCESS_IDS.map(id => buildFunctionRollupUrl(warehouseId, id, dt));
        const results = await Promise.all(urls.map(fetchFclmRows));
        const rows = results.flat();

        let total = 0;
        rows.forEach(row => {
            if (DA_VALID_JOB_ACTIONS.includes(row['Job Action']) && (row['Unit Type'] === 'Case' || row['Unit Type'] === 'Tote')) {
                total += parseInt(row['Units'], 10) || 0;
            }
        });

        return total;
    }

    async function scrapePprCsvData(dt, warehouseId) {
        const csvUrl = `https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=CSV&warehouseId=${warehouseId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${dt.startDateString}&startHourIntraday=${dt.startHour}&startMinuteIntraday=${dt.startMinute}&endDateIntraday=${dt.endDateString}&endHourIntraday=${dt.endHour}&endMinuteIntraday=${dt.endMinute}&_adjustPlanHours=on&_hideEmptyLineItems=on&_rememberViewForWarehouse=on&employmentType=AllEmployees`;

        const htmlUrl = `https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=HTML&warehouseId=${warehouseId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${dt.startDateString}&startHourIntraday=${dt.startHour}&startMinuteIntraday=${dt.startMinute}&endDateIntraday=${dt.endDateString}&endHourIntraday=${dt.endHour}&endMinuteIntraday=${dt.endMinute}&_adjustPlanHours=on&_hideEmptyLineItems=on&_rememberViewForWarehouse=on&employmentType=AllEmployees`;

        const [csvText, htmlText] = await Promise.all([
            gmRequest(csvUrl),
            gmRequest(htmlUrl)
        ]);

        let actualThroughputHours = 0;
        const lines = parseCSVText(csvText);

        for (const line of lines) {
            const values = parseCSVLine(line);
            const rowId = (values[2] || '').trim();

            if (rowId === 'ppr.fcSummary.throughput') {
                actualThroughputHours = parseFloat(values[8]) || 0;
                break;
            }
        }

        const doc = new DOMParser().parseFromString(htmlText, 'text/html');

        // The injected row #ppr.detail.inbound.carton.prpallets does NOT exist in raw FCLM HTML.
        // Use the native FCLM rows instead and sum them.
        const transferInPalletNode = doc.querySelector(
            'tr[id="ppr.detail.inbound.transferInAndStow.palletTransferIn"] td.actualVolume.numeric div.original'
        );

        const receivePalletNode = doc.querySelector(
            'tr[id="ppr.detail.inbound.receive.palletReceive"] td.actualVolume.numeric div.original'
        );

        const transferInPallets = transferInPalletNode
            ? (parseFloat((transferInPalletNode.textContent || '').replace(/[^\d.-]/g, '')) || 0)
            : 0;

        const receivePallets = receivePalletNode
            ? (parseFloat((receivePalletNode.textContent || '').replace(/[^\d.-]/g, '')) || 0)
            : 0;

        const palletReceiveTotal = transferInPallets + receivePallets;

        const extractPprNode = (selector) => {
            const node = doc.querySelector(selector);
            return node ? (parseFloat((node.textContent || '').replace(/[^\d.-]/g, '')) || 0) : 0;
        };

        const totalHours           = extractPprNode('tr[id="ppr.rcSummary.throughput"] td.numeric.actualTimeSeconds div.original');
        const plannedThroughputHours = extractPprNode('tr[id="ppr.rcSummary.throughput"] td.numeric.planTimeSeconds div.original');
        const sortUnits    = extractPprNode('tr[id="ppr.detail.da.rcSort.rcSort.total"] td.actualVolume.numeric div.original');
        const presortCases = extractPprNode('tr[id="ppr.detail.da.rcSort.rcSortCases"] td.actualVolume.numeric div.original');

        return {
            actualThroughputHours,
            palletReceiveTotal,
            totalHours,
            plannedThroughputHours,
            sortUnits,
            presortCases
        };
    }

    function buildFunctionRollupHtmlUrl(warehouseId, processId, dt) {
        return `https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=${warehouseId}&processId=${processId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${dt.startDateString}&startHourIntraday=${dt.startHour}&startMinuteIntraday=${dt.startMinute}&endDateIntraday=${dt.endDateString}&endHourIntraday=${dt.endHour}&endMinuteIntraday=${dt.endMinute}`;
    }

    function parseSortCell(cell, isHours = false) {
        if (!cell) return 0;
        const text = (cell.textContent || '').trim();
        const val = parseFloat(text.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        return isHours ? parseFloat(val.toFixed(2)) : val;
    }

    function extractSortTableData(doc, tableId) {
        const table = doc.querySelector(`table#${tableId}`);
        if (!table) return { volume: 0, hours: 0 };
        const cells = Array.from(table.querySelectorAll('tfoot tr td'));
        return {
            volume: parseSortCell(cells[15]),
            hours:  parseSortCell(cells[4], true)
        };
    }


    async function scrapeNEOPlannedHours(reportDate) {
        // reportDate: YYYY-MM-DD (from report-date input)
        // Step 1: dynamically fetch the current plan_id for each shift from /plan endpoint.
        //         Plan IDs rotate with schedule periods (not dates). NEO_PLAN_IDS are fallbacks.
        // Full lookup chain for a given shift + date:
        //   1. shift?site_id=ONT8&shift=day|night&date=DATE&department=...
        //      → {shift_id: 206376, ...}  (changes each schedule period)
        //   2. plan?staffing_profile_id=84&shift=SHIFT_ID
        //      → [{plan_id, plan_type, ...}, ...]  → find plan_type='sos'
        async function resolveShiftPlanId(shiftLabel, fallbackPlanId) {
            // Step A: resolve shift_id for this date
            let shiftId = null;
            try {
                const shiftUrl = `https://neo.meta.amazon.dev/api/v2/shift` +
                    `?site_id=ONT8&shift=${shiftLabel}&date=${reportDate}` +
                    `&department=${encodeURIComponent(NEO_PLAN_PARAMS.department)}`;
                console.log(`[Bridge AutoCalc] NEO — resolving shift_id for ${shiftLabel}: ${shiftUrl}`);
                const shiftRaw  = await gmRequest(shiftUrl);
                const shiftJson = JSON.parse(shiftRaw);
                shiftId = shiftJson.shift_id ?? shiftJson.id ?? (Array.isArray(shiftJson) ? shiftJson[0]?.shift_id : null);
                console.log(`[Bridge AutoCalc] NEO — shift_id for ${shiftLabel} on ${reportDate}: ${shiftId}`);
            } catch (e) {
                console.warn(`[Bridge AutoCalc] NEO — shift lookup failed for ${shiftLabel}: ${e.message}`);
            }

            if (!shiftId) {
                console.warn(`[Bridge AutoCalc] NEO — could not resolve shift_id for ${shiftLabel}; using fallback plan_id ${fallbackPlanId}`);
                return fallbackPlanId;
            }

            // Step B: get plan list for this shift_id and find the sos plan
            try {
                const planUrl  = `https://neo.meta.amazon.dev/api/v2/planning/plan` +
                    `?staffing_profile_id=${NEO_PLAN_PARAMS.staffing_profile_id}&shift=${shiftId}`;
                const planRaw  = await gmRequest(planUrl);
                const plans    = JSON.parse(planRaw);
                if (Array.isArray(plans)) {
                    const match = plans.find(p => p.plan_type === NEO_PLAN_PARAMS.plan_name);
                    if (match?.plan_id != null) {
                        console.log(`[Bridge AutoCalc] NEO — resolved plan_id for ${shiftLabel}: shift_id=${shiftId} plan_id=${match.plan_id}`);
                        return match.plan_id;
                    }
                    console.warn(`[Bridge AutoCalc] NEO — no sos plan for ${shiftLabel} shift_id=${shiftId}; available:`,
                        plans.map(p => `${p.plan_type}=${p.plan_id}`).join(', '));
                }
            } catch (e) {
                console.warn(`[Bridge AutoCalc] NEO — plan lookup failed for ${shiftLabel}: ${e.message}`);
            }

            console.warn(`[Bridge AutoCalc] NEO — falling back to hardcoded plan_id ${fallbackPlanId} for ${shiftLabel}`);
            return fallbackPlanId;
        }

        // Resolve plan IDs for both shifts concurrently (2 sequential GETs each, run in parallel)
        const [dayPlanId, nightPlanId] = await Promise.all([
            resolveShiftPlanId('day',   NEO_PLAN_IDS.day),
            resolveShiftPlanId('night', NEO_PLAN_IDS.night)
        ]);

        // Step 3: call generate_plan with resolved IDs + the report date (drives ALPS inputs)
        const buildGeneratePlanUrl = (shift, planId) =>
            `https://neo.meta.amazon.dev/api/v2/planning/generate_plan` +
            `?site_id=ONT8` +
            `&shift=${shift}` +
            `&date=${reportDate}` +
            `&plan_id=${planId}` +
            `&department=${encodeURIComponent(NEO_PLAN_PARAMS.department)}` +
            `&staffing_profile_id=${NEO_PLAN_PARAMS.staffing_profile_id}` +
            `&plan_name=${NEO_PLAN_PARAMS.plan_name}`;

        const dayUrl   = buildGeneratePlanUrl('day',   dayPlanId);
        const nightUrl = buildGeneratePlanUrl('night', nightPlanId);
        console.log(`[Bridge AutoCalc] NEO — fetching day:   ${dayUrl}`);
        console.log(`[Bridge AutoCalc] NEO — fetching night: ${nightUrl}`);

        const [dayRaw, nightRaw] = await Promise.all([
            gmRequest(dayUrl),
            gmRequest(nightUrl)
        ]);

        const dayJson   = JSON.parse(dayRaw);
        const nightJson = JSON.parse(nightRaw);

        // Response: Array[4] sections.
        // Target: sections[title="Assumptions"] -> data[name="Total Building Hours"]
        //         -> subfunctions[name="Planned Total Hours (excl. Support)"] -> .plan
        // If .plan is null (SOS not yet committed), falls back to .recommendation.
        const TARGET_SECTION = 'Assumptions';
        const TARGET_ITEM    = 'Total Building Hours';
        const TARGET_SUB     = /planned total hours.*excl/i;

        function extractHours(sections, shiftLabel) {
            if (!Array.isArray(sections)) {
                console.warn(`[Bridge AutoCalc] NEO — ${shiftLabel}: response is not an array`, sections);
                return 0;
            }

            const section = sections.find(s => s.title === TARGET_SECTION);
            if (!section) {
                console.warn(`[Bridge AutoCalc] NEO — ${shiftLabel}: section "${TARGET_SECTION}" not found`);
                return 0;
            }

            const item = (section.data || []).find(d => d.name === TARGET_ITEM);
            if (!item) {
                console.warn(`[Bridge AutoCalc] NEO — ${shiftLabel}: item "${TARGET_ITEM}" not found`);
                return 0;
            }

            const sub = (item.subfunctions || []).find(s => TARGET_SUB.test(s.name || ''));
            if (!sub) {
                console.warn(`[Bridge AutoCalc] NEO — ${shiftLabel}: subfunction matching "${TARGET_SUB}" not found`);
                (item.subfunctions || []).forEach(s => console.log(`  available: ${s.name}`));
                return 0;
            }

            // Prefer SOS plan value; fall back to recommendation if plan is null/undefined
            const raw = sub.plan ?? sub.recommendation ?? 0;
            const val = parseFloat(raw) || 0;
            console.log(`[Bridge AutoCalc] NEO — ${shiftLabel}: "${sub.name}" → plan=${sub.plan}, recommendation=${sub.recommendation}, using=${val}`);
            return val;
        }

        const dayHours   = extractHours(dayJson,   'day');
        const nightHours = extractHours(nightJson, 'night');
        console.log(`[Bridge AutoCalc] NEO — day hours: ${dayHours}, night hours: ${nightHours}`);

        const total = parseFloat((dayHours + nightHours).toFixed(2));
        console.log(`[Bridge AutoCalc] NEO — total planned hours (c9): ${total}`);
        return total;
    }

    async function scrapeInstantVTOHours(dt, warehouseId) {
        // Instant VTO acceptances are ad-hoc pop-up offers — always pre-accepted,
        // so every record counts fully toward actual hours (no plan/headcount side).
        const startDate = dt.startDateRaw.replace(/\//g, '-');
        const url = `https://scheduling.amazon.com/api/get-instant-vto-acceptances-by-site` +
                    `?searchStart=${startDate}T00:00:00&searchEnd=${startDate}T23:59:59&siteId=${warehouseId}`;
        console.log(`[Bridge AutoCalc] Instant VTO — fetching: ${url}`);

        const raw = await gmRequest(url);
        const allInstant = JSON.parse(raw) || [];
        console.log(`[Bridge AutoCalc] Instant VTO — acceptances returned: ${allInstant.length}`);

        const filtered = allInstant.filter(a => !(a.workgroups || []).includes('On Road'));

        let actualHrs = 0;
        filtered.forEach(a => {
            const start = a.appliedVto?.startDateTime;
            const end   = a.appliedVto?.endDateTime;
            if (!start || !end) return;
            const dur = (new Date(end) - new Date(start)) / 3600000;
            console.log(`[Bridge AutoCalc] Instant VTO — ${a.employeeName || a.employeeId} | ${start} → ${end} | ${dur.toFixed(2)}h`);
            actualHrs += dur;
        });

        const actual = parseFloat(actualHrs.toFixed(1));
        console.log(`[Bridge AutoCalc] Instant VTO — total actual hours: ${actual}`);
        return actual;
    }

    // ── SandOp NetworkViewer capture (runs only on portal.sandop.a2z.com) ──────
    // Intercepts the page's own NVF/TI metric-family API calls and stashes the
    // "Days of End Backlog" forecast series (keyed by date) into GM storage so
    // Bridge AutoCalc (a different origin) can read them via GM_getValue.
    const SANDOP_NVF_METRIC_ID = 'DaysOfEndVendorFreightBacklog';       // "Forecasted Days of End Vendor Freight Backlog"
    const SANDOP_TI_METRIC_ID  = 'DaysOfEndTransferInBacklogOnsiteGCF'; // "Forecasted Locked Days of End Onsite Transfer In Backlog"
    const SANDOP_TARGET_NODE   = 'ONT8';

    // One-time purge: v5.7 could persist a wrong-metric map under the NVF key,
    // and the reader would keep serving it forever. Bumping this version wipes
    // both stored maps so only freshly-captured (id-verified) data is used.
    const SANDOP_STORAGE_VER = '5.8';
    if (GM_getValue('sandop_storage_ver', '') !== SANDOP_STORAGE_VER) {
        GM_setValue('sandop_nvf_bl_by_date', '{}');
        GM_setValue('sandop_ti_bl_by_date', '{}');
        GM_setValue('sandop_storage_ver', SANDOP_STORAGE_VER);
        console.log('[SandOp Capture] Storage version bump — cleared stale NVF/TI BL maps.');
    }

    function metricToDateMap(json, metric) {
        const dates = json.periodStartDates || [];
        const map = {};
        dates.forEach((d, i) => {
            const v = metric.values[i];
            if (v !== null && v !== undefined) map[d] = v;
        });
        return map;
    }

    // Pick the NVF metric strictly: exact id first, then any Forecast metric whose
    // id mentions VendorFreight + backlog-days — but NEVER anything TransferIn.
    function pickNVFMetric(metrics) {
        let m = metrics.find(x => x.id === SANDOP_NVF_METRIC_ID && x.type === 'Forecast');
        if (m) return m;
        return metrics.find(x =>
            x.type === 'Forecast' &&
            /VendorFreight/i.test(x.id) &&
            /DaysOfEnd/i.test(x.id) &&
            !/TransferIn/i.test(x.id)
        ) || null;
    }

    function pickTIMetric(metrics) {
        let m = metrics.find(x => x.id === SANDOP_TI_METRIC_ID && x.type === 'Forecast');
        if (m) return m;
        return metrics.find(x =>
            x.type === 'Forecast' &&
            /TransferIn/i.test(x.id) &&
            /DaysOfEnd/i.test(x.id) &&
            !/VendorFreight/i.test(x.id)
        ) || null;
    }

    // Storage is now driven by the metric id found in the payload — never by
    // which URL family the response came from — so a kind mismatch can no
    // longer cross-contaminate the NVF/TI keys.
    function storeSandOpMetrics(json, sourceUrl) {
        try {
            // Telemetry: prove to the Bridge side that a family response was seen at all.
            GM_setValue('sandop_family_seen', Date.now());
            GM_setValue('sandop_family_last_url', sourceUrl);

            const rec = (json.records || []).find(r => r.granularity && r.granularity.node === SANDOP_TARGET_NODE);
            if (!rec) {
                const nodes = (json.records || []).map(r => r.granularity && r.granularity.node).filter(Boolean);
                console.warn(`[SandOp Capture] Family response seen but no ${SANDOP_TARGET_NODE} record. Nodes present:`, nodes.slice(0, 20));
                GM_setValue('sandop_extract_note', `no ${SANDOP_TARGET_NODE} record in ${sourceUrl}`);
                return;
            }
            const metrics = rec.metrics || [];

            // Diagnostic: dump every metric id/type present for ONT8 so the
            // correct NVF id can be read straight off the console if it differs.
            console.log(`[SandOp Capture] ${SANDOP_TARGET_NODE} metrics in ${sourceUrl}:`,
                metrics.map(m => `${m.id} (${m.type})`).join(' | '));

            const nvfMetric = pickNVFMetric(metrics);
            if (nvfMetric) {
                const map = metricToDateMap(json, nvfMetric);
                if (Object.keys(map).length) {
                    GM_setValue('sandop_nvf_bl_by_date', JSON.stringify(map));
                    GM_setValue('sandop_nvf_bl_updated', Date.now());
                    console.log(`[SandOp Capture] NVF BL map updated from metric id "${nvfMetric.id}" —`, map);
                }
            }

            const tiMetric = pickTIMetric(metrics);
            if (tiMetric) {
                const map = metricToDateMap(json, tiMetric);
                if (Object.keys(map).length) {
                    GM_setValue('sandop_ti_bl_by_date', JSON.stringify(map));
                    GM_setValue('sandop_ti_bl_updated', Date.now());
                    console.log(`[SandOp Capture] TI BL map updated from metric id "${tiMetric.id}" —`, map);
                }
            }
        } catch (e) {
            console.warn('[SandOp Capture] Failed to process metric-family response', e);
        }
    }

    // Record the full request spec (url, method, headers, body) for each family
    // so the Bridge side can replay it later via GM_xmlhttpRequest — no portal
    // visit or iframe needed once a spec has been recorded.
    const SANDOP_SKIP_HEADERS = /^(cookie|host|content-length|origin|referer|connection|accept-encoding)$/i;

    function sandOpFamilyKey(url) {
        const m = url.match(/\/metric\/family\/NetworkViewer\/([^/?]+)/);
        return m ? m[1] : null;
    }

    function saveSandOpRequestSpec(url, method, headers, body) {
        const family = sandOpFamilyKey(url);
        if (!family) return;
        const cleanHeaders = {};
        Object.entries(headers || {}).forEach(([k, v]) => {
            if (!SANDOP_SKIP_HEADERS.test(k) && typeof v === 'string') cleanHeaders[k] = v;
        });
        const spec = {
            url: new URL(url, location.origin).href,
            method: (method || 'GET').toUpperCase(),
            headers: cleanHeaders,
            body: (typeof body === 'string') ? body : null,
            saved: Date.now()
        };
        GM_setValue(`sandop_req_spec_${family}`, JSON.stringify(spec));
        console.log(`[SandOp Capture] Recorded request spec for ${family} (${spec.method}) — Bridge can now replay this directly.`);
    }

    function initSandOpCapture() {
        console.log('[SandOp Capture] Installing fetch/XHR interceptors on portal.sandop.a2z.com');
        // Heartbeat so the Bridge side can tell whether this script actually ran
        // inside the hidden iframe (vs. the frame being blocked entirely).
        GM_setValue('sandop_frame_alive', Date.now());
        setInterval(() => GM_setValue('sandop_frame_alive', Date.now()), 2000);

        // Patch fetch — any NetworkViewer metric-family response is scanned;
        // the metric ids inside the payload decide where the data is stored.
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await origFetch.apply(this, args);
            try {
                const req = args[0];
                const init = args[1] || {};
                const url = (typeof req === 'string') ? req : (req && req.url) || '';
                if (url) GM_setValue('sandop_any_req_seen', Date.now());
                if (url.includes('/metric/')) {
                    console.log(`[SandOp Capture] fetch ${response.status} → ${url}`);
                    if (response.status === 401 || response.status === 403 || response.redirected) {
                        GM_setValue('sandop_auth_problem', `fetch ${response.status}${response.redirected ? ' (redirected)' : ''} on ${url}`);
                    }
                }
                if (url.includes('/metric/family/NetworkViewer/') && response.ok) {
                    // Record the request spec for later replay
                    try {
                        let method = init.method || (req && req.method) || 'GET';
                        let headers = {};
                        const rawHeaders = init.headers || (req && req.headers);
                        if (rawHeaders) {
                            if (typeof rawHeaders.forEach === 'function') {
                                rawHeaders.forEach((v, k) => { headers[k] = v; });
                            } else {
                                headers = { ...rawHeaders };
                            }
                        }
                        const body = (typeof init.body === 'string') ? init.body : null;
                        saveSandOpRequestSpec(url, method, headers, body);
                    } catch (e) { /* ignore */ }
                    response.clone().json().then(json => storeSandOpMetrics(json, url)).catch(e => {
                        console.warn('[SandOp Capture] Family response was not JSON (likely an auth redirect page):', url, e);
                        GM_setValue('sandop_auth_problem', `non-JSON family response on ${url}`);
                    });
                }
            } catch (e) { /* ignore */ }
            return response;
        };

        // Patch XHR (in case the portal uses XHR/axios instead of fetch)
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._sandopUrl = url;
            this._sandopMethod = method;
            this._sandopHeaders = {};
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            try { if (this._sandopHeaders) this._sandopHeaders[name] = value; } catch (e) { /* ignore */ }
            return origSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (...args) {
            this._sandopBody = (typeof args[0] === 'string') ? args[0] : null;
            this.addEventListener('load', function () {
                try {
                    const url = this._sandopUrl || '';
                    if (url) GM_setValue('sandop_any_req_seen', Date.now());
                    if (url.includes('/metric/')) {
                        console.log(`[SandOp Capture] xhr ${this.status} → ${url}`);
                        if (this.status === 401 || this.status === 403) {
                            GM_setValue('sandop_auth_problem', `xhr ${this.status} on ${url}`);
                        }
                    }
                    if (url.includes('/metric/family/NetworkViewer/') && this.status >= 200 && this.status < 300) {
                        saveSandOpRequestSpec(url, this._sandopMethod, this._sandopHeaders, this._sandopBody);
                        const json = JSON.parse(this.responseText);
                        storeSandOpMetrics(json, url);
                    }
                } catch (e) { /* ignore */ }
            });
            return origSend.apply(this, args);
        };
    }

    // ── Bridge AutoCalc reader for SandOp-captured values ──────────────────────
    function getSandOpBacklogDays(reportDate) {
        let nvfBLDays = null, tiBLDays = null;
        try {
            const nvfMap = JSON.parse(GM_getValue('sandop_nvf_bl_by_date', '{}'));
            if (reportDate in nvfMap) nvfBLDays = nvfMap[reportDate];
        } catch (e) { /* ignore */ }
        try {
            const tiMap = JSON.parse(GM_getValue('sandop_ti_bl_by_date', '{}'));
            if (reportDate in tiMap) tiBLDays = tiMap[reportDate];
        } catch (e) { /* ignore */ }
        return { nvfBLDays, tiBLDays };
    }

    // ── Silent SandOp NetworkViewer capture trigger ────────────────────────────
    // Preferred path: replay the recorded metric-family requests directly via
    // GM_xmlhttpRequest (extension-level, real first-party cookies — immune to
    // Firefox cookie partitioning). Falls back to the hidden iframe if no specs
    // have been recorded yet or the replay fails.
    const SANDOP_NETWORKVIEWER_URL = 'https://portal.sandop.a2z.com/#!/network-viewer';
    const SANDOP_CAPTURE_TIMEOUT_MS = 25000;   // heavy SPA — give it time
    const SANDOP_POLL_INTERVAL_MS   = 500;
    const SANDOP_SPEC_STALE_MS      = 3 * 24 * 3600 * 1000; // warn if spec > 3 days old

    function replaySandOpSpec(family) {
        return new Promise((resolve) => {
            let spec;
            try {
                spec = JSON.parse(GM_getValue(`sandop_req_spec_${family}`, 'null'));
            } catch (e) { spec = null; }
            if (!spec || !spec.url) { resolve(false); return; }

            const ageMs = Date.now() - (spec.saved || 0);
            if (ageMs > SANDOP_SPEC_STALE_MS) {
                console.warn(`[Bridge AutoCalc] SandOp ${family} request spec is ${(ageMs / 86400000).toFixed(1)} days old — ` +
                    'replaying anyway, but visit NetworkViewer to refresh it if values look off.');
            }
            console.log(`[Bridge AutoCalc] Replaying SandOp ${family} request directly (${spec.method} ${spec.url})`);

            GM_xmlhttpRequest({
                method: spec.method,
                url: spec.url,
                headers: spec.headers || {},
                data: spec.body || undefined,
                timeout: 15000,
                onload: (res) => {
                    try {
                        if (res.status < 200 || res.status >= 300) {
                            console.warn(`[Bridge AutoCalc] SandOp ${family} replay got HTTP ${res.status} — ` +
                                'auth token in the recorded spec may have expired. Visit NetworkViewer to re-record.');
                            resolve(false);
                            return;
                        }
                        const json = JSON.parse(res.responseText);
                        storeSandOpMetrics(json, `${spec.url} (replayed)`);
                        resolve(true);
                    } catch (e) {
                        console.warn(`[Bridge AutoCalc] SandOp ${family} replay response was not JSON (likely an auth redirect).`, e);
                        resolve(false);
                    }
                },
                onerror: () => { console.warn(`[Bridge AutoCalc] SandOp ${family} replay network error.`); resolve(false); },
                ontimeout: () => { console.warn(`[Bridge AutoCalc] SandOp ${family} replay timed out.`); resolve(false); }
            });
        });
    }

    async function trySandOpDirectReplay() {
        const families = ['NewVendorFreight', 'NewTransferIn'];
        const haveSpecs = families.some(f => GM_getValue(`sandop_req_spec_${f}`, null));
        if (!haveSpecs) {
            console.log('[Bridge AutoCalc] No recorded SandOp request specs yet — open NetworkViewer once (NVF + TI views) to record them.');
            return false;
        }
        const t0 = Date.now();
        await Promise.all(families.map(f => replaySandOpSpec(f)));
        const nvfFresh = GM_getValue('sandop_nvf_bl_updated', 0) > t0;
        const tiFresh  = GM_getValue('sandop_ti_bl_updated', 0) > t0;
        if (nvfFresh && tiFresh) {
            console.log('[Bridge AutoCalc] SandOp direct replay OK — both NVF and TI BL maps refreshed without touching the portal.');
            return true;
        }
        console.warn(`[Bridge AutoCalc] SandOp direct replay incomplete (NVF: ${nvfFresh}, TI: ${tiFresh}) — falling back to hidden iframe.`);
        return false;
    }

    async function triggerSandOpCapture() {
        // 1) Direct replay of recorded requests — fast, partition-proof.
        if (await trySandOpDirectReplay()) return;

        // 2) Hidden-iframe fallback (may fail on Firefox — diagnostics will say why).
        return new Promise((resolve) => {
            const t0 = Date.now();
            console.log('[Bridge AutoCalc] Loading SandOp NetworkViewer in background iframe for NVF/TI BL capture...');
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
            iframe.src = SANDOP_NETWORKVIEWER_URL;

            let settled = false;
            let pollTimer = null;

            const diagnose = () => {
                const frameAlive  = GM_getValue('sandop_frame_alive', 0) > t0;
                const anyReq      = GM_getValue('sandop_any_req_seen', 0) > t0;
                const familySeen  = GM_getValue('sandop_family_seen', 0) > t0;
                const nvfFresh    = GM_getValue('sandop_nvf_bl_updated', 0) > t0;
                const tiFresh     = GM_getValue('sandop_ti_bl_updated', 0) > t0;
                const authProblem = GM_getValue('sandop_auth_problem', '');
                const extractNote = GM_getValue('sandop_extract_note', '');
                if (nvfFresh && tiFresh) {
                    console.log('[Bridge AutoCalc] SandOp capture OK — both NVF and TI BL maps refreshed.');
                } else if (!frameAlive) {
                    console.warn('[Bridge AutoCalc] SandOp capture FAILED: userscript never ran inside the hidden iframe (X-Frame-Options/CSP block).');
                } else if (!anyReq) {
                    console.warn('[Bridge AutoCalc] SandOp capture FAILED: frame ran but the app made NO network requests at all — ' +
                        'the portal likely detected embedding and refused to boot, or Midway auth blocked before any API call.');
                } else if (familySeen) {
                    console.warn('[Bridge AutoCalc] SandOp capture FAILED at extraction: family responses WERE seen ' +
                        `(last: ${GM_getValue('sandop_family_last_url', '?')}) but maps not stored ` +
                        `(NVF: ${nvfFresh}, TI: ${tiFresh}). ${extractNote ? 'Note: ' + extractNote : ''}`);
                } else {
                    console.warn('[Bridge AutoCalc] SandOp capture FAILED: frame ran and the app made requests, but no ' +
                        'NetworkViewer metric-family calls fired within the window. ' +
                        (authProblem ? `Auth problem detected: ${authProblem}. ` : '') +
                        'Likely Firefox cookie partitioning (unauthenticated in-frame session) or the SPA only fires ' +
                        'these calls when the NVF/TI views are opened. Fallback: open NetworkViewer in a normal tab.');
                }
            };

            const cleanup = () => {
                if (settled) return;
                settled = true;
                if (pollTimer) clearInterval(pollTimer);
                diagnose();
                iframe.remove();
                resolve();
            };

            // Resolve early as soon as both maps have been refreshed by this run.
            pollTimer = setInterval(() => {
                if (GM_getValue('sandop_nvf_bl_updated', 0) > t0 &&
                    GM_getValue('sandop_ti_bl_updated', 0) > t0) {
                    cleanup();
                }
            }, SANDOP_POLL_INTERVAL_MS);

            iframe.addEventListener('error', () => {
                console.warn('[Bridge AutoCalc] SandOp iframe fired an error event — blocked before load.');
                cleanup();
            });

            document.body.appendChild(iframe);
            setTimeout(cleanup, SANDOP_CAPTURE_TIMEOUT_MS);
        });
    }

    async function scrapeVTOData(dt, warehouseId) {
        // Query only the bridge start date — VET/VTO opportunities are posted on the shift date
        const startDate = dt.startDateRaw.replace(/\//g, '-');
        const url = `https://scheduling.amazon.com/api/get-opportunities-by-date-range` +
                    `?searchStart=${startDate}T00:00:00&searchEnd=${startDate}T23:59:59&siteId=${warehouseId}`;
        console.log(`[Bridge AutoCalc] VTO — fetching: ${url}`);

        const [raw, instantVtoActual] = await Promise.all([
            gmRequest(url),
            scrapeInstantVTOHours(dt, warehouseId)
        ]);
        const json = JSON.parse(raw);
        const allOpps = json.opportunityList || [];
        console.log(`[Bridge AutoCalc] VTO — opportunities returned: ${allOpps.length}`);

        const vtoEntries = allOpps.filter(o => o.opportunityType === 'VoluntaryTimeOff' && !(o.workgroups || []).includes('On Road'));
        const vetEntries = allOpps.filter(o => o.opportunityType === 'VoluntaryOvertime'  && !(o.workgroups || []).includes('On Road'));
        console.log(`[Bridge AutoCalc] VTO — VoluntaryTimeOff entries: ${vtoEntries.length}`);
        console.log(`[Bridge AutoCalc] VET — VoluntaryOvertime entries: ${vetEntries.length}`);

        function calcHours(entries) {
            let actualHrs = 0, planHrs = 0;
            entries.forEach(o => {
                const dur     = (new Date(o.opportunityEnd) - new Date(o.opportunityStart)) / 3600000;
                const accepted = (o.acceptedEmployees || []).length;
                const planned  = o.headcount || 0;
                console.log(`[Bridge AutoCalc] ${o.opportunityType} — ${o.opportunityStart} → ${o.opportunityEnd} | ${dur.toFixed(2)}h | accepted=${accepted} headcount=${planned}`);
                actualHrs += dur * accepted;
                planHrs   += dur * planned;
            });
            return { actual: parseFloat(actualHrs.toFixed(1)), plan: parseFloat(planHrs.toFixed(1)) };
        }

        const vto = calcHours(vtoEntries);
        const vet = calcHours(vetEntries);
        const vtoActualCombined = parseFloat((vto.actual + instantVtoActual).toFixed(1));
        const vtoPlanCombined   = parseFloat((vto.plan   + instantVtoActual).toFixed(1));
        console.log(`[Bridge AutoCalc] VTO — opportunity actual: ${vto.actual}, opportunity plan: ${vto.plan}, instant: ${instantVtoActual}, combined actual: ${vtoActualCombined}, combined plan: ${vtoPlanCombined}`);
        console.log(`[Bridge AutoCalc] VET — actual: ${vet.actual}, plan: ${vet.plan}`);
        return { vtoActual: vtoActualCombined, vtoPlan: vtoPlanCombined, vetActual: vet.actual, vetPlan: vet.plan };
    }

    async function scrapeSortData(dt, warehouseId) {
        const url = buildFunctionRollupHtmlUrl(warehouseId, SORT_PROCESS_ID, dt);
        const html = await gmRequest(url);
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const combine = (ids) => ids.reduce(
            (acc, id) => {
                const { volume, hours } = extractSortTableData(doc, id);
                return { volume: acc.volume + volume, hours: acc.hours + hours };
            },
            { volume: 0, hours: 0 }
        );

        const uis5    = combine(SORT_TABLE_IDS.uis5);
        const uis20   = combine(SORT_TABLE_IDS.uis20);
        const mansort = combine(SORT_TABLE_IDS.mansort);

        return {
            uis5Rate:     uis5.hours    > 0 ? uis5.volume    / uis5.hours    : 0,
            uis20Rate:    uis20.hours   > 0 ? uis20.volume   / uis20.hours   : 0,
            mansortRate:  mansort.hours > 0 ? mansort.volume / mansort.hours : 0,
            uis5Hours:    uis5.hours,
            uis20Hours:   uis20.hours,
            mansortHours: mansort.hours
        };
    }

    // ── Loading bar ──────────────────────────────────────────────────────────
    function createProgressBar() {
        if (document.getElementById('tm-pull-progress-wrap')) return;
        const wrap = document.createElement('div');
        wrap.id = 'tm-pull-progress-wrap';
        wrap.style.cssText = `
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 999999;
            height: 4px;
            background: rgba(0,0,0,0.12);
        `;
        const bar = document.createElement('div');
        bar.id = 'tm-pull-progress-bar';
        bar.style.cssText = `
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #f90, #ff6a00);
            box-shadow: 0 0 8px #f90;
            transition: width 0.3s ease;
            border-radius: 0 2px 2px 0;
        `;
        wrap.appendChild(bar);
        document.body.appendChild(wrap);
    }

    function startProgress() {
        createProgressBar();
        const wrap = document.getElementById('tm-pull-progress-wrap');
        const bar  = document.getElementById('tm-pull-progress-bar');
        if (!wrap || !bar) return;
        wrap.style.display = 'block';
        bar.style.transition = 'none';
        bar.style.width = '0%';
        // Animate to 85% over ~8s to give sense of progress without knowing true duration
        requestAnimationFrame(() => {
            bar.style.transition = 'width 8s cubic-bezier(0.1, 0.05, 0.3, 1)';
            bar.style.width = '85%';
        });
    }

    function finishProgress(success = true) {
        const wrap = document.getElementById('tm-pull-progress-wrap');
        const bar  = document.getElementById('tm-pull-progress-bar');
        if (!wrap || !bar) return;
        bar.style.transition = 'width 0.25s ease';
        bar.style.background = success
            ? 'linear-gradient(90deg, #22c55e, #16a34a)'
            : 'linear-gradient(90deg, #ef4444, #b91c1c)';
        bar.style.width = '100%';
        setTimeout(() => {
            wrap.style.display = 'none';
            bar.style.width = '0%';
            bar.style.background = 'linear-gradient(90deg, #f90, #ff6a00)';
        }, 600);
    }

    async function pullCombinedCartons() {
        const reportDate = getInputValue('report-date');
        if (!reportDate) {
            showToast('Set the report date first', true);
            return;
        }

        try {
            startProgress();
            showToast('Pulling actuals...');

            const dt = buildBridgeDateTime();
            const warehouseId = getWarehouseId();

            const [fclmData, igraphData, daTransferOut, pprCsvData, sortData, vtoData, neoPlannedHours] = await Promise.all([
                scrapeFclmCombinedCartons(dt, warehouseId),
                scrapeIGraphCombinedCartons(dt, warehouseId),
                scrapeDATransferOut(dt, warehouseId),
                scrapePprCsvData(dt, warehouseId),
                scrapeSortData(dt, warehouseId),
                scrapeVTOData(dt, warehouseId),
                scrapeNEOPlannedHours(reportDate),
                triggerSandOpCapture()
            ]);

            const totalPalletsReceived = pprCsvData.palletReceiveTotal || 0;
            const tiPidCartons = fclmData.tiPidCartons || 0;
            const totalNVFCartons = igraphData.totalNVFCartons || 0;
            const combinedCartons = (fclmData.palletReceive || 0) + tiPidCartons + totalNVFCartons;
            const pidCartons = tiPidCartons + totalNVFCartons;

            setInputValue(FIELD_MAP.combinedCartons, Math.round(combinedCartons).toLocaleString('en-US'));
            setInputValue(FIELD_MAP.pidCartons, Math.round(pidCartons).toLocaleString('en-US'));
            setInputValue(FIELD_MAP.palletReceive, Math.round(totalPalletsReceived).toLocaleString('en-US'));
            setInputValue(FIELD_MAP.tiPidCartons, Math.round(tiPidCartons).toLocaleString('en-US'));
            console.log(`[Bridge AutoCalc] VTO — setting b11=${vtoData.vtoActual}, c11=${vtoData.vtoPlan}`);
            setInputValue(FIELD_MAP.vtoActual, vtoData.vtoActual.toFixed(1));
            setInputValue(FIELD_MAP.vtoPlan,   vtoData.vtoPlan.toFixed(1));
            console.log(`[Bridge AutoCalc] VET — setting b10=${vtoData.vetActual}, c10=${vtoData.vetPlan}`);
            setInputValue(FIELD_MAP.vetActual, vtoData.vetActual.toFixed(1));
            setInputValue(FIELD_MAP.vetPlan,   vtoData.vetPlan.toFixed(1));
            setInputValue(FIELD_MAP.totalHours,    (pprCsvData.totalHours    || 0).toFixed(2));
            setInputValue(FIELD_MAP.neoPlannedHours, neoPlannedHours.toFixed(2));
            setInputValue(FIELD_MAP.sortUnits,    Math.round(pprCsvData.sortUnits    || 0).toLocaleString('en-US'));
            setInputValue(FIELD_MAP.presortCases, Math.round(pprCsvData.presortCases || 0).toLocaleString('en-US'));

            const sandopBL = getSandOpBacklogDays(reportDate);
            if (sandopBL.nvfBLDays !== null) {
                setInputValue(FIELD_MAP.nvfBacklogDays, sandopBL.nvfBLDays.toFixed(2));
            } else {
                console.warn(`[Bridge AutoCalc] NVF BL not captured for ${reportDate} yet — open the NetworkViewer tab on portal.sandop.a2z.com for that date first.`);
            }
            if (sandopBL.tiBLDays !== null) {
                setInputValue(FIELD_MAP.tiBacklogDays, sandopBL.tiBLDays.toFixed(2));
            } else {
                console.warn(`[Bridge AutoCalc] TI BL not captured for ${reportDate} yet — open the NetworkViewer tab on portal.sandop.a2z.com for that date first.`);
            }

            const throughputHours = pprCsvData.actualThroughputHours || 0;
            if (throughputHours > 0) {
                const throughputCPLH = (combinedCartons + daTransferOut) / throughputHours;
                setInputValue(FIELD_MAP.throughputCPLH, throughputCPLH.toFixed(1));
                setInputValue(FIELD_MAP.throughputCPLH2, throughputCPLH.toFixed(1));
            }

            if (sortData.uis5Rate > 0 || sortData.uis5Hours > 0) {
                setInputValue(FIELD_MAP.uis5Rate,     sortData.uis5Rate.toFixed(2));
                setInputValue(FIELD_MAP.uis20Rate,    sortData.uis20Rate.toFixed(2));
                setInputValue(FIELD_MAP.mansortRate,  sortData.mansortRate.toFixed(2));
                setInputValue(FIELD_MAP.uis5Hours,    sortData.uis5Hours.toFixed(2));
                setInputValue(FIELD_MAP.uis20Hours,   sortData.uis20Hours.toFixed(2));
                setInputValue(FIELD_MAP.mansortHours, sortData.mansortHours.toFixed(2));
            }

            if (typeof window.calcAll === 'function') {
                window.calcAll();
            }
            if (typeof window.buildNarrative === 'function') {
                window.buildNarrative();
            }

            finishProgress(true);
            showToast(`Actuals loaded: CC ${Math.round(combinedCartons).toLocaleString('en-US')} | PID ${Math.round(pidCartons).toLocaleString('en-US')} | PR ${Math.round(totalPalletsReceived).toLocaleString('en-US')}`);
        } catch (error) {
            finishProgress(false);
            console.error('Actuals pull failed:', error);
            showToast(`Pull failed: ${error.message}`, true);
        }
    }

    function addButton() {
        if (document.getElementById('tm-pull-combined-btn')) return;

        const container = document.querySelector('.import-bar');
        if (!container) {
            console.warn('[Bridge AutoCalc] .import-bar not found — button not injected');
            return false;
        }

        const divider = document.createElement('div');
        divider.className = 'import-bar-divider';

        const button = document.createElement('button');
        button.id = 'tm-pull-combined-btn';
        button.className = 'btn-import btn-import-ib';
        button.textContent = '↻ Pull Actuals';
        button.addEventListener('click', pullCombinedCartons);

        container.appendChild(divider);
        container.appendChild(button);
        console.log('[Bridge AutoCalc] Pull Actuals button injected');
        return true;
    }

    async function init() {
        console.log('[Bridge AutoCalc] v1.9 — script loaded, waiting for DOM...');
        await wait(STARTUP_DELAY);

        if (addButton()) return;

        // Fallback: watch for .import-bar to appear dynamically
        console.log('[Bridge AutoCalc] Falling back to MutationObserver for .import-bar');
        const observer = new MutationObserver(() => {
            if (addButton()) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Safety timeout — stop watching after 30 s
        setTimeout(() => {
            observer.disconnect();
            console.warn('[Bridge AutoCalc] Gave up waiting for .import-bar after 30 s');
        }, 30000);
    }

    if (location.hostname === 'portal.sandop.a2z.com') {
        initSandOpCapture();
    } else {
        init();
    }
})();