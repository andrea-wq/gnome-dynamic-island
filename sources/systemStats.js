import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder('utf-8');
const statFile = Gio.File.new_for_path('/proc/stat');
const memFile = Gio.File.new_for_path('/proc/meminfo');
const netFile = Gio.File.new_for_path('/proc/net/dev');
const rootFile = Gio.File.new_for_path('/');

function readTextSync(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

function loadTextAsync(file, cancellable = null) {
    if (!file)
        return Promise.resolve(null);
    return new Promise(resolve => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                resolve(ok ? decoder.decode(bytes).trim() : null);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function queryFsAsync(file, cancellable = null) {
    return new Promise(resolve => {
        file.query_filesystem_info_async('filesystem::size,filesystem::used,filesystem::free',
            GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                try {
                    const info = f.query_filesystem_info_finish(res);
                    const total = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    const used = info.get_attribute_uint64('filesystem::used') || Math.max(0, total - free);
                    resolve({total, used});
                } catch (e) {
                    resolve(null);
                }
            });
    });
}

function findThermalZones() {
    const zones = {cpu: null, nvme: null, wifi: null};
    try {
        const dir = Gio.File.new_for_path('/sys/class/thermal');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('thermal_zone'))
                continue;
            const type = readTextSync(`/sys/class/thermal/${name}/type`);
            if (!type)
                continue;
            const tempPath = `/sys/class/thermal/${name}/temp`;
            if (type === 'x86_pkg_temp' || type.includes('Tctl') || type.includes('cpu'))
                zones.cpu = zones.cpu || tempPath;
            else if (type.includes('iwlwifi'))
                zones.wifi = zones.wifi || tempPath;
            else if (type === 'acpitz' && !zones.cpu)
                zones.cpu = tempPath;
        }
    } catch (e) {
        // Ignore
    }

    try {
        const dir = Gio.File.new_for_path('/sys/class/hwmon');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const hwName = readTextSync(`/sys/class/hwmon/${name}/name`);
            const t1 = `/sys/class/hwmon/${name}/temp1_input`;
            if (!GLib.file_test(t1, GLib.FileTest.EXISTS))
                continue;
            if (hwName === 'coretemp' || hwName === 'k10temp' || hwName === 'zenpower')
                zones.cpu = t1;
            else if (hwName === 'nvme')
                zones.nvme = t1;
            else if (hwName === 'iwlwifi_1')
                zones.wifi = zones.wifi || t1;
        }
    } catch (e) {
        // Ignore
    }
    return zones;
}

function findGpuPaths() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/drm');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!/^card\d+$/.test(name))
                continue;
            const busyPath = `/sys/class/drm/${name}/device/gpu_busy_percent`;
            if (GLib.file_test(busyPath, GLib.FileTest.EXISTS))
                return {busyPath, curFreqPath: null, maxFreqPath: null};

            const curFreqPath = `/sys/class/drm/${name}/gt_cur_freq_mhz`;
            const maxFreqPath = `/sys/class/drm/${name}/gt_max_freq_mhz`;
            if (GLib.file_test(curFreqPath, GLib.FileTest.EXISTS))
                return {busyPath: null, curFreqPath, maxFreqPath};
        }
    } catch (e) {
        // Ignore
    }
    return {busyPath: null, curFreqPath: null, maxFreqPath: null};
}

function findBatteryPath() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/power_supply');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const base = `/sys/class/power_supply/${name}`;
            if (readTextSync(`${base}/type`) === 'Battery')
                return base;
        }
    } catch (e) {
        // Ignore
    }
    return null;
}

export class SystemStats {
    constructor() {
        this._lastTotal = 0;
        this._lastIdle = 0;
        this._lastRx = 0;
        this._lastTx = 0;
        this._lastNetTime = 0;
        this._sampling = false;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();

        const zones = findThermalZones();
        const gpu = findGpuPaths();
        const batPath = findBatteryPath();

        const optFile = p => p ? Gio.File.new_for_path(p) : null;
        this._tempFiles = {
            cpu: optFile(zones.cpu),
            nvme: optFile(zones.nvme),
            wifi: optFile(zones.wifi),
        };
        this._gpuBusyFile = optFile(gpu.busyPath);
        this._gpuCurFile = optFile(gpu.curFreqPath);
        this._gpuMaxFreq = gpu.maxFreqPath ? (Number(readTextSync(gpu.maxFreqPath)) || 1000) : 1000;
        this._batFiles = batPath
            ? {
                status: Gio.File.new_for_path(`${batPath}/status`),
                powerNow: Gio.File.new_for_path(`${batPath}/power_now`),
                currentNow: Gio.File.new_for_path(`${batPath}/current_now`),
                voltageNow: Gio.File.new_for_path(`${batPath}/voltage_now`),
                capacity: Gio.File.new_for_path(`${batPath}/capacity`),
            }
            : null;
    }

    async sampleAsync(callback) {
        if (this._sampling || this._destroyed)
            return;
        this._sampling = true;

        try {
            const c = this._cancellable;
            const [
                statTxt, memTxt, netTxt, fsInfo,
                gpuBusyTxt, gpuCurTxt,
                cpuTempTxt, nvmeTempTxt, wifiTempTxt,
                batStatusTxt, batPowerTxt, batCurrTxt, batVoltTxt, batCapTxt,
            ] = await Promise.all([
                loadTextAsync(statFile, c),
                loadTextAsync(memFile, c),
                loadTextAsync(netFile, c),
                queryFsAsync(rootFile, c),
                loadTextAsync(this._gpuBusyFile, c),
                loadTextAsync(this._gpuCurFile, c),
                loadTextAsync(this._tempFiles.cpu, c),
                loadTextAsync(this._tempFiles.nvme, c),
                loadTextAsync(this._tempFiles.wifi, c),
                loadTextAsync(this._batFiles?.status, c),
                loadTextAsync(this._batFiles?.powerNow, c),
                loadTextAsync(this._batFiles?.currentNow, c),
                loadTextAsync(this._batFiles?.voltageNow, c),
                loadTextAsync(this._batFiles?.capacity, c),
            ]);

            if (this._destroyed)
                return;

            // 1. CPU %
            let cpu = 0;
            if (statTxt) {
                const nl = statTxt.indexOf('\n');
                const line = nl >= 0 ? statTxt.slice(0, nl) : statTxt;
                const parts = line.trim().split(/\s+/);
                let total = 0;
                for (let i = 1; i < parts.length; i++)
                    total += Number(parts[i]) || 0;
                const idle = (Number(parts[4]) || 0) + (Number(parts[5]) || 0);
                const dTotal = total - this._lastTotal;
                const dIdle = idle - this._lastIdle;
                if (this._lastTotal > 0 && dTotal > 0)
                    cpu = Math.round(Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)));
                this._lastTotal = total;
                this._lastIdle = idle;
            }

            // 2. RAM % and GB
            let ramPct = 0;
            let ramUsedGb = 0;
            let ramTotalGb = 0;
            if (memTxt) {
                const totalMatch = memTxt.match(/MemTotal:\s+(\d+)/);
                const availMatch = memTxt.match(/MemAvailable:\s+(\d+)/);
                if (totalMatch && availMatch) {
                    const totalKb = Number(totalMatch[1]);
                    const availKb = Number(availMatch[1]);
                    if (totalKb > 0) {
                        const usedKb = Math.max(0, totalKb - availKb);
                        ramPct = Math.round((usedKb / totalKb) * 100);
                        ramUsedGb = (usedKb / 1048576).toFixed(1);
                        ramTotalGb = (totalKb / 1048576).toFixed(1);
                    }
                }
            }

            // 3. Network RX/TX speed
            let rxRate = 0;
            let txRate = 0;
            if (netTxt) {
                let rxSum = 0;
                let txSum = 0;
                const lines = netTxt.split('\n');
                for (let i = 2; i < lines.length; i++) {
                    const trimmed = lines[i].trim();
                    if (!trimmed || trimmed.startsWith('lo:'))
                        continue;
                    const cols = trimmed.split(/[:\s]+/);
                    if (cols.length >= 10) {
                        rxSum += Number(cols[1]) || 0;
                        txSum += Number(cols[9]) || 0;
                    }
                }
                const now = GLib.get_monotonic_time();
                if (this._lastNetTime > 0) {
                    const dt = (now - this._lastNetTime) / 1e6;
                    if (dt > 0.1) {
                        rxRate = Math.max(0, (rxSum - this._lastRx) / dt);
                        txRate = Math.max(0, (txSum - this._lastTx) / dt);
                    }
                }
                this._lastRx = rxSum;
                this._lastTx = txSum;
                this._lastNetTime = now;
            }

            // 4. Storage
            let diskPct = 0;
            let diskUsedGb = 0;
            let diskTotalGb = 0;
            if (fsInfo && fsInfo.total > 0) {
                diskPct = Math.round((fsInfo.used / fsInfo.total) * 100);
                diskUsedGb = Math.round(fsInfo.used / 1e9);
                diskTotalGb = Math.round(fsInfo.total / 1e9);
            }

            // 5. GPU
            let gpuLabel = 'N/D';
            let gpuSub = '';
            if (gpuBusyTxt !== null) {
                const busy = Number(gpuBusyTxt);
                if (Number.isFinite(busy)) {
                    gpuLabel = `${Math.round(busy)}%`;
                    gpuSub = 'Utilizzo GPU';
                }
            } else if (gpuCurTxt !== null) {
                const cur = Number(gpuCurTxt);
                if (Number.isFinite(cur)) {
                    const pct = Math.min(100, Math.round((cur / this._gpuMaxFreq) * 100));
                    gpuLabel = `${pct}%`;
                    gpuSub = `${cur} MHz`;
                }
            }

            // 6. Temperatures
            const parseTemp = txt => {
                if (txt === null)
                    return null;
                const val = Number(txt);
                return Number.isFinite(val) && val > 0 ? Math.round(val / 1000) : null;
            };
            const cpuTemp = parseTemp(cpuTempTxt);
            const nvmeTemp = parseTemp(nvmeTempTxt);
            const wifiTemp = parseTemp(wifiTempTxt);

            // 7. Battery Power (W) and Voltage (V)
            let power = {
                present: false,
                status: 'AC',
                watts: 0,
                volts: 0,
                capacity: 100,
            };
            if (this._batFiles) {
                const status = batStatusTxt || 'Unknown';
                const powerNow = Number(batPowerTxt);
                const currentNow = Number(batCurrTxt);
                const voltageNow = Number(batVoltTxt);
                const capacity = Number(batCapTxt);

                const volts = Number.isFinite(voltageNow) && voltageNow > 0 ? voltageNow / 1e6 : 0;
                let watts = 0;
                if (Number.isFinite(powerNow) && powerNow > 0)
                    watts = powerNow / 1e6;
                else if (Number.isFinite(currentNow) && volts > 0)
                    watts = (Math.abs(currentNow) / 1e6) * volts;

                power = {
                    present: true,
                    status,
                    watts,
                    volts,
                    capacity: Number.isFinite(capacity) ? Math.round(capacity) : 100,
                };
            }

            callback({
                cpu,
                cpuTemp,
                ramPct,
                ramUsedGb,
                ramTotalGb,
                gpuLabel,
                gpuSub,
                diskPct,
                diskUsedGb,
                diskTotalGb,
                rxRate,
                txRate,
                nvmeTemp,
                wifiTemp,
                power,
            });
        } finally {
            this._sampling = false;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
    }
}
