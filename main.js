/* ==========================================================================
   GRIYA SEHATI – Modular IoT Monitoring & Simulation Engine
   Architecture:
   1. SensorStore      (Data model & telemetry ingestion interface)
   2. StatusEvaluator  (Threshold logic, sensor health, & alarm notifications)
   3. SimulationEngine (Gradual drift, presets, & multi-range history generator)
   4. ChartManager     (Chart.js lifecycle & dynamic updates)
   5. UIRenderer       (DOM binding for KPIs, discrete tank, septic, tables)
   6. EventController  (Navigation, sliders, CSV export, settings)
   ========================================================================== */

(() => {
  'use strict';

  // ------------------------------------------------------------------------
  // 1. SENSOR STORE (Data Sensor & IoT Adapter Ready)
  // ------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    tankCapacityL: 1000,
    tankRefHeightCm: 120,
    ultrasonicBlindZoneCm: 10,
    tankLowWarnPct: 25,
    tankHighWarnPct: 85,
    septicCapacityL: 2000,
    septicHeightCm: 150,
    ecToTdsFactor: 0.50,
    turbidityWarn: 5.0,
    turbidityDanger: 12.0,
    tdsWarn: 500,
    tdsDanger: 900,
    phMin: 6.5,
    phMax: 8.5,
    septicWarn: 75,
    septicDanger: 90,
    h2sWarn: 10.0,
    h2sDanger: 20.0,
    ch4Warn: 10.0,
    ch4Danger: 20.0,
    nh3Warn: 15.0,
    nh3Danger: 25.0,
    simIntervalMs: 2500,
    deviceOnline: true,
    simulatedErrorSensor: 'none'
  };

  const SensorStore = {
    config: { ...DEFAULT_CONFIG },
    simulationRunning: true,
    activePreset: 'normal',
    activePage: 'dashboard',
    tandonRange: '1h',
    historyRange: '1h',
    notifFilter: 'all',

    // Current live telemetry
    current: {
      timestamp: new Date(),
      waterLevelRaw: 78, // target/simulated water level (%)
      ultrasonicDistanceCm: 26.4, // measured distance from top sensor to water surface
      inletFlow: 11.8,   // L/min
      outletFlow: 7.4,   // L/min
      inletTotalL: 482.5,
      outletTotalL: 365.0,
      turbidity: 1.4,    // NTU
      ec: 370,           // µS/cm
      tds: 185,          // ppm (derived from EC * factor)
      ph: 7.2,
      temperature: 27.4, // °C (DS18B20)
      septicLevel: 42,   // %
      gasH2S: 1.8,       // ppm
      gasCH4: 3.2,       // %LEL
      gasNH3: 4.5        // ppm
    },

    // Target baselines for gradual drift
    targets: {
      waterLevelRaw: 78,
      inletFlow: 11.8,
      outletFlow: 7.4,
      turbidity: 1.4,
      ec: 370,
      ph: 7.2,
      temperature: 27.4,
      septicLevel: 42,
      gasH2S: 1.8,
      gasCH4: 3.2,
      gasNH3: 4.5
    },

    // Live session series (last 30 points for real-time charts)
    liveSeries: [],
    // Historical archives by range
    archives: {
      '1h': [],
      '24h': [],
      '7d': [],
      '30d': []
    },

    notifications: [],
    lastAlertTimes: {},

    /**
     * Future Firebase / MQTT Adapter Entry Point:
     * Replace SimulationEngine.tick() with Firebase onValue() or MQTT message handler
     * calling SensorStore.ingestTelemetry(payload).
     */
    ingestTelemetry(payload) {
      const prev = this.current;
      const nextRawPct = payload.waterLevelRaw ?? prev.waterLevelRaw;
      const nextDistCm = payload.ultrasonicDistanceCm !== undefined
        ? payload.ultrasonicDistanceCm
        : +(this.config.tankRefHeightCm * (1 - nextRawPct / 100)).toFixed(1);

      this.current = {
        ...prev,
        ...payload,
        ultrasonicDistanceCm: nextDistCm,
        tds: Math.round((payload.ec ?? prev.ec) * this.config.ecToTdsFactor),
        timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date()
      };
      this.pushSnapshot(this.current);
    },

    pushSnapshot(snapshot) {
      const metrics = computeUltrasonicTankMetrics(snapshot.ultrasonicDistanceCm);
      const point = {
        ...snapshot,
        detectedLevelPct: metrics.valid ? Math.round(metrics.levelPct * 10) / 10 : Math.round(snapshot.waterLevelRaw)
      };
      this.liveSeries.push(point);
      if (this.liveSeries.length > 30) {
        this.liveSeries.shift();
      }
      this.archives['1h'].push(point);
      if (this.archives['1h'].length > 60) {
        this.archives['1h'].shift();
      }
    }
  };

  /**
   * Continuous ultrasonic water level calculation with blind-zone & range validation:
   * Tinggi air = Tinggi acuan tandon - Jarak sensor ke permukaan air
   * Level (%)  = (Tinggi air / Tinggi acuan tandon) * 100%
   * Volume (L) = (Level (%) / 100) * Kapasitas maksimum tandon
   */
  function computeUltrasonicTankMetrics(distanceCm) {
    const cfg = SensorStore.config;
    const refCm = cfg.tankRefHeightCm;
    const blindCm = cfg.ultrasonicBlindZoneCm;

    if (!cfg.deviceOnline) {
      return {
        valid: false,
        reason: 'offline',
        distanceCm: null,
        heightCm: 0,
        levelPct: 0,
        volumeL: 0
      };
    }

    const outOfRange = !Number.isFinite(distanceCm) || distanceCm < blindCm || distanceCm > refCm;
    if (cfg.simulatedErrorSensor === 'ultrasonic' || outOfRange) {
      return {
        valid: false,
        reason: distanceCm < blindCm ? 'blind_zone' : 'sensor_error',
        distanceCm: Number.isFinite(distanceCm) ? distanceCm : null,
        heightCm: 0,
        levelPct: 0,
        volumeL: 0
      };
    }

    const heightCm = Math.max(0, Math.min(refCm, refCm - distanceCm));
    const levelPct = Math.max(0, Math.min(100, (heightCm / refCm) * 100));
    const volumeL = Math.max(0, Math.min(cfg.tankCapacityL, (levelPct / 100) * cfg.tankCapacityL));

    return {
      valid: true,
      reason: 'ok',
      distanceCm,
      heightCm,
      levelPct,
      volumeL
    };
  }

  // ------------------------------------------------------------------------
  // 2. STATUS EVALUATOR & NOTIFICATION SYSTEM
  // ------------------------------------------------------------------------
  const StatusEvaluator = {
    evaluate() {
      const c = SensorStore.current;
      const cfg = SensorStore.config;
      const errSensor = cfg.simulatedErrorSensor;

      const tankMetrics = computeUltrasonicTankMetrics(c.ultrasonicDistanceCm);
      let waterStatus = { code: 'normal', label: 'Normal' };
      let ultrasonicStatus = { code: 'normal', label: 'Aktif' };

      if (!cfg.deviceOnline) {
        waterStatus = { code: 'danger', label: 'Offline' };
        ultrasonicStatus = { code: 'danger', label: 'Tidak Terhubung' };
      } else if (!tankMetrics.valid) {
        waterStatus = { code: 'error', label: 'Sensor Error' };
        ultrasonicStatus = { code: 'error', label: 'Error' };
      } else if (tankMetrics.levelPct <= cfg.tankLowWarnPct) {
        waterStatus = { code: 'danger', label: 'Rendah' };
      } else if (tankMetrics.levelPct >= cfg.tankHighWarnPct) {
        waterStatus = { code: 'info', label: 'Penuh' };
      }

      const turbStatus = errSensor === 'turbidity'
        ? { code: 'error', label: 'Sensor Error' }
        : c.turbidity >= cfg.turbidityDanger
          ? { code: 'danger', label: 'Danger' }
          : c.turbidity >= cfg.turbidityWarn
            ? { code: 'warning', label: 'Warning' }
            : { code: 'normal', label: 'Normal' };

      const ecStatus = errSensor === 'ec'
        ? { code: 'error', label: 'Sensor Error' }
        : c.tds >= cfg.tdsDanger
          ? { code: 'danger', label: 'Danger' }
          : c.tds >= cfg.tdsWarn
            ? { code: 'warning', label: 'Warning' }
            : { code: 'normal', label: 'Normal' };

      const tdsStatus = errSensor === 'ec'
        ? { code: 'error', label: 'Sensor Error' }
        : ecStatus;

      const phStatus = errSensor === 'ph'
        ? { code: 'error', label: 'Sensor Error' }
        : (c.ph < cfg.phMin - 0.7 || c.ph > cfg.phMax + 0.7)
          ? { code: 'danger', label: 'Danger' }
          : (c.ph < cfg.phMin || c.ph > cfg.phMax)
            ? { code: 'warning', label: 'Warning' }
            : { code: 'normal', label: 'Normal' };

      const tempStatus = c.temperature >= 36 || c.temperature <= 18
        ? { code: 'warning', label: 'Warning' }
        : { code: 'normal', label: 'Normal' };

      const qualityRank = { error: 3, danger: 2, warning: 1, normal: 0 };
      const worstQuality = [turbStatus, tdsStatus, phStatus, ecStatus, tempStatus]
        .reduce((acc, s) => (qualityRank[s.code] > qualityRank[acc.code] ? s : acc), { code: 'normal', label: 'Normal' });

      const septicTankStatus = c.septicLevel >= cfg.septicDanger
        ? { code: 'danger', label: 'Danger' }
        : c.septicLevel >= cfg.septicWarn
          ? { code: 'warning', label: 'Warning' }
          : { code: 'normal', label: 'Normal' };

      const h2sStatus = errSensor === 'h2s'
        ? { code: 'error', label: 'Sensor Error' }
        : c.gasH2S >= cfg.h2sDanger
          ? { code: 'danger', label: 'Danger' }
          : c.gasH2S >= cfg.h2sWarn
            ? { code: 'warning', label: 'Warning' }
            : { code: 'normal', label: 'Normal' };

      const ch4Status = c.gasCH4 >= cfg.ch4Danger
        ? { code: 'danger', label: 'Danger' }
        : c.gasCH4 >= cfg.ch4Warn
          ? { code: 'warning', label: 'Warning' }
          : { code: 'normal', label: 'Normal' };

      const nh3Status = c.gasNH3 >= cfg.nh3Danger
        ? { code: 'danger', label: 'Danger' }
        : c.gasNH3 >= cfg.nh3Warn
          ? { code: 'warning', label: 'Warning' }
          : { code: 'normal', label: 'Normal' };

      const worstSeptic = [septicTankStatus, h2sStatus, ch4Status, nh3Status]
        .reduce((acc, s) => (qualityRank[s.code] > qualityRank[acc.code] ? s : acc), { code: 'normal', label: 'Normal' });

      const activeSensors = errSensor === 'none' ? 10 : 9;

      return {
        tankMetrics,
        waterStatus,
        ultrasonicStatus,
        turbStatus,
        tdsStatus,
        phStatus,
        ecStatus,
        tempStatus,
        worstQuality,
        septicTankStatus,
        h2sStatus,
        ch4Status,
        nh3Status,
        worstSeptic,
        activeSensors
      };
    },

    checkAndNotify(evalResult) {
      const c = SensorStore.current;
      const cfg = SensorStore.config;

      if (!cfg.deviceOnline) {
        this.emitNotification('offline', 'danger', 'Perangkat Offline', 'Node ESP32-GS01 tidak merespons pembaruan telemetri.');
        return;
      }

      if (cfg.simulatedErrorSensor !== 'none') {
        this.emitNotification(
          `err_${cfg.simulatedErrorSensor}`,
          'warning',
          'Sensor Tidak Memberikan Respons',
          `Sensor ${cfg.simulatedErrorSensor.toUpperCase()} melaporkan status Sensor Error.`
        );
      }

      if (!evalResult.tankMetrics.valid && cfg.simulatedErrorSensor !== 'ultrasonic') {
        this.emitNotification(
          'ultrasonic_range',
          'warning',
          'Pembacaan Sensor Ultrasonik Tidak Valid',
          evalResult.tankMetrics.reason === 'blind_zone'
            ? `Jarak permukaan air (${evalResult.tankMetrics.distanceCm?.toFixed(1)} cm) berada di dalam blind zone (< ${cfg.ultrasonicBlindZoneCm} cm).`
            : 'Jarak pembacaan sensor ultrasonik berada di luar rentang acuan tandon.'
        );
      } else if (evalResult.tankMetrics.valid) {
        if (evalResult.tankMetrics.levelPct <= cfg.tankLowWarnPct) {
          this.emitNotification(
            'water_low',
            'warning',
            'Level Air Tandon Rendah',
            `Ketinggian air tandon ${Math.round(evalResult.tankMetrics.levelPct)}% (estimasi ${Math.round(evalResult.tankMetrics.volumeL)} L).`
          );
        } else if (evalResult.tankMetrics.levelPct >= cfg.tankHighWarnPct) {
          this.emitNotification(
            'water_full',
            'info',
            'Tandon Air Hampir Penuh',
            `Ketinggian air mencapai ${Math.round(evalResult.tankMetrics.levelPct)}% (${Math.round(evalResult.tankMetrics.volumeL)} L).`
          );
        }
      }

      if (evalResult.turbStatus.code === 'danger' || evalResult.turbStatus.code === 'warning') {
        this.emitNotification(
          'turbidity',
          evalResult.turbStatus.code,
          'Kekeruhan Air Mengalami Peningkatan',
          `Turbidity tercatat ${c.turbidity.toFixed(1)} NTU (ambang peringatan ${cfg.turbidityWarn} NTU).`
        );
      }

      if (evalResult.tdsStatus.code === 'danger' || evalResult.tdsStatus.code === 'warning') {
        this.emitNotification(
          'tds',
          evalResult.tdsStatus.code,
          'TDS Mengalami Perubahan Signifikan',
          `Estimasi TDS mencapai ${c.tds} ppm (dari EC ${Math.round(c.ec)} µS/cm).`
        );
      }

      if (evalResult.phStatus.code === 'danger' || evalResult.phStatus.code === 'warning') {
        this.emitNotification(
          'ph',
          evalResult.phStatus.code,
          'Nilai pH di Luar Rentang Konfigurasi',
          `pH air terukur ${c.ph.toFixed(1)} (rentang normal ${cfg.phMin}–${cfg.phMax}).`
        );
      }

      if (evalResult.septicTankStatus.code === 'danger' || evalResult.septicTankStatus.code === 'warning') {
        this.emitNotification(
          'septic',
          evalResult.septicTankStatus.code,
          'Tangki Septik Mendekati Kapasitas Maksimal',
          `Kepenuhan tangki septik mencapai ${Math.round(c.septicLevel)}%. Segera jadwalkan pemeriksaan.`
        );
      }

      if (evalResult.h2sStatus.code === 'danger' || evalResult.h2sStatus.code === 'warning' ||
          evalResult.ch4Status.code === 'danger' || evalResult.ch4Status.code === 'warning') {
        this.emitNotification(
          'gas',
          (evalResult.h2sStatus.code === 'danger' || evalResult.ch4Status.code === 'danger') ? 'danger' : 'warning',
          'Konsentrasi Gas Melewati Ambang Demonstrasi',
          `H₂S: ${c.gasH2S.toFixed(1)} ppm, CH₄: ${c.gasCH4.toFixed(1)} %LEL (ambang demonstrasi).`
        );
      }
    },

    emitNotification(key, category, title, message) {
      const now = Date.now();
      const cooldownMs = 18000; // prevent spamming identical alerts every 2.5s
      if (SensorStore.lastAlertTimes[key] && (now - SensorStore.lastAlertTimes[key] < cooldownMs)) {
        return;
      }
      SensorStore.lastAlertTimes[key] = now;

      SensorStore.notifications.unshift({
        id: `${key}_${now}`,
        category, // 'info' | 'warning' | 'danger'
        title,
        message,
        timestamp: new Date(now),
        read: false
      });

      if (SensorStore.notifications.length > 40) {
        SensorStore.notifications.pop();
      }
    }
  };

  // ------------------------------------------------------------------------
  // 3. SIMULATION ENGINE
  // ------------------------------------------------------------------------
  const SimulationEngine = {
    timerId: null,

    init() {
      this.seedHistoricalArchives();
      SensorStore.notifications = [
        {
          id: 'init_1',
          category: 'info',
          title: 'Sistem Simulasi Griya Sehati Aktif',
          message: 'Seluruh 10 kanal sensor virtual berjalan dalam Simulation Mode.',
          timestamp: new Date(),
          read: false
        }
      ];
      this.start();
    },

    start() {
      if (this.timerId) clearInterval(this.timerId);
      SensorStore.simulationRunning = true;
      this.timerId = setInterval(() => this.tick(), SensorStore.config.simIntervalMs);
    },

    pause() {
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      SensorStore.simulationRunning = false;
    },

    reset() {
      this.applyPreset('normal');
      SensorStore.config.simulatedErrorSensor = 'none';
      SensorStore.config.deviceOnline = true;
      SensorStore.current.inletTotalL = 482.5;
      SensorStore.current.outletTotalL = 365.0;
      StatusEvaluator.emitNotification('reset', 'info', 'Simulasi Direset', 'Parameter dikembalikan ke kondisi normal awal.');
      App.refreshAll();
    },

    applyPreset(preset) {
      SensorStore.activePreset = preset;
      const presets = {
        normal: {
          waterLevelRaw: 78,
          inletFlow: 11.8,
          outletFlow: 7.4,
          turbidity: 1.4,
          ec: 370,
          ph: 7.2,
          temperature: 27.4,
          septicLevel: 42,
          gasH2S: 1.8,
          gasCH4: 3.2,
          gasNH3: 4.5
        },
        warning: {
          waterLevelRaw: 45,
          inletFlow: 4.2,
          outletFlow: 9.8,
          turbidity: 6.4,
          ec: 1120,
          ph: 6.1,
          temperature: 30.2,
          septicLevel: 79,
          gasH2S: 12.5,
          gasCH4: 11.8,
          gasNH3: 16.4
        },
        danger: {
          waterLevelRaw: 18,
          inletFlow: 0.0,
          outletFlow: 12.4,
          turbidity: 15.8,
          ec: 1920,
          ph: 5.3,
          temperature: 34.5,
          septicLevel: 93,
          gasH2S: 23.4,
          gasCH4: 24.0,
          gasNH3: 27.2
        }
      };

      const p = presets[preset] || presets.normal;
      SensorStore.targets = { ...p };
      // Immediately move current halfway toward preset for responsive demo feedback, then drift smoothly
      Object.keys(p).forEach((k) => {
        SensorStore.current[k] = p[k];
      });
      SensorStore.current.ultrasonicDistanceCm = +(SensorStore.config.tankRefHeightCm * (1 - p.waterLevelRaw / 100)).toFixed(1);
      SensorStore.current.tds = Math.round(SensorStore.current.ec * SensorStore.config.ecToTdsFactor);
      StatusEvaluator.emitNotification(
        `preset_${preset}`,
        preset === 'danger' ? 'danger' : preset === 'warning' ? 'warning' : 'info',
        `Skenario ${preset.toUpperCase()} Diaktifkan`,
        `Target simulasi sensor disesuaikan ke profil kondisi ${preset}.`
      );
      App.refreshAll();
    },

    tick() {
      if (!SensorStore.simulationRunning || !SensorStore.config.deviceOnline) return;

      const c = SensorStore.current;
      const t = SensorStore.targets;
      const dtSec = SensorStore.config.simIntervalMs / 1000;

      // Gradual drift helper: pulls gently toward target with small realistic noise
      const drift = (cur, target, step, noise, min, max) => {
        const delta = (target - cur) * 0.25 + (Math.random() - 0.5) * noise;
        const clampedStep = Math.max(-step, Math.min(step, delta));
        return Math.max(min, Math.min(max, cur + clampedStep));
      };

      const nextInlet = drift(c.inletFlow, t.inletFlow, 0.8, 0.7, 0, 25);
      const nextOutlet = drift(c.outletFlow, t.outletFlow, 0.8, 0.9, 0, 25);

      // Volume accumulation
      const addedL = (nextInlet / 60) * dtSec;
      const usedL = (nextOutlet / 60) * dtSec;

      const nextEc = drift(c.ec, t.ec, 25, 18, 50, 2400);

      SensorStore.ingestTelemetry({
        waterLevelRaw: drift(c.waterLevelRaw, t.waterLevelRaw, 1.8, 1.2, 0, 100),
        inletFlow: nextInlet,
        outletFlow: nextOutlet,
        inletTotalL: c.inletTotalL + addedL,
        outletTotalL: c.outletTotalL + usedL,
        turbidity: drift(c.turbidity, t.turbidity, 0.4, 0.25, 0.2, 25),
        ec: nextEc,
        ph: drift(c.ph, t.ph, 0.1, 0.08, 4.0, 10.0),
        temperature: drift(c.temperature, t.temperature, 0.2, 0.15, 18, 42),
        septicLevel: drift(c.septicLevel, t.septicLevel, 0.8, 0.4, 0, 100),
        gasH2S: drift(c.gasH2S, t.gasH2S, 0.6, 0.4, 0, 35),
        gasCH4: drift(c.gasCH4, t.gasCH4, 0.7, 0.5, 0, 40),
        gasNH3: drift(c.gasNH3, t.gasNH3, 0.7, 0.5, 0, 40),
        timestamp: new Date()
      });

      App.refreshAll();
    },

    seedHistoricalArchives() {
      const now = Date.now();
      const buildSeries = (count, stepMs) => {
        const arr = [];
        let lvl = 76;
        let turb = 1.5;
        let ec = 365;
        let ph = 7.2;
        let temp = 27.2;
        let septic = 40;
        let h2s = 1.7;
        let ch4 = 3.0;
        let nh3 = 4.2;

        for (let i = count - 1; i >= 0; i--) {
          lvl = Math.max(20, Math.min(98, lvl + (Math.random() - 0.48) * 3));
          turb = Math.max(0.5, Math.min(6, turb + (Math.random() - 0.5) * 0.3));
          ec = Math.max(200, Math.min(650, ec + (Math.random() - 0.5) * 18));
          ph = Math.max(6.4, Math.min(8.2, ph + (Math.random() - 0.5) * 0.12));
          temp = Math.max(25, Math.min(31, temp + (Math.random() - 0.5) * 0.25));
          septic = Math.max(25, Math.min(72, septic + (Math.random() - 0.48) * 0.6));
          h2s = Math.max(0.5, Math.min(8, h2s + (Math.random() - 0.5) * 0.4));
          ch4 = Math.max(1.0, Math.min(9, ch4 + (Math.random() - 0.5) * 0.5));
          nh3 = Math.max(1.5, Math.min(11, nh3 + (Math.random() - 0.5) * 0.5));

          const inlet = Math.max(0, 10 + (Math.random() - 0.4) * 6);
          const outlet = Math.max(0, 7 + (Math.random() - 0.4) * 5);

          arr.push({
            timestamp: new Date(now - i * stepMs),
            waterLevelRaw: lvl,
            detectedLevelPct: Math.round(lvl * 10) / 10,
            inletFlow: inlet,
            outletFlow: outlet,
            turbidity: turb,
            ec: ec,
            tds: Math.round(ec * SensorStore.config.ecToTdsFactor),
            ph: ph,
            temperature: temp,
            septicLevel: septic,
            gasH2S: h2s,
            gasCH4: ch4,
            gasNH3: nh3
          });
        }
        return arr;
      };

      SensorStore.archives['1h'] = buildSeries(24, 150 * 1000);
      SensorStore.archives['24h'] = buildSeries(24, 3600 * 1000);
      SensorStore.archives['7d'] = buildSeries(28, 6 * 3600 * 1000);
      SensorStore.archives['30d'] = buildSeries(30, 24 * 3600 * 1000);
      SensorStore.liveSeries = SensorStore.archives['1h'].slice(-20);
    }
  };

  // ------------------------------------------------------------------------
  // 4. CHART MANAGER (Chart.js)
  // ------------------------------------------------------------------------
  const ChartManager = {
    charts: {},

    commonOptions(unitLabel = '', stepped = false) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              color: '#71808C',
              font: { size: 11, family: 'Inter, sans-serif' }
            }
          },
          tooltip: {
            backgroundColor: '#263746',
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            padding: 8,
            cornerRadius: 6
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#94A3B0',
              font: { size: 10 },
              maxTicksLimit: 6
            }
          },
          y: {
            grid: { color: '#EEF2F5' },
            ticks: {
              color: '#71808C',
              font: { size: 10 },
              callback: (v) => (unitLabel ? `${v} ${unitLabel}` : v)
            }
          }
        },
        elements: {
          line: { tension: stepped ? 0 : 0.3, borderWidth: 2 },
          point: { radius: 0, hoverRadius: 4 }
        }
      };
    },

    createLineChart(canvasId, datasets, unitLabel = '', stepped = false) {
      const ctx = document.getElementById(canvasId);
      if (!ctx) return null;
      const chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets },
        options: this.commonOptions(unitLabel, stepped)
      });
      this.charts[canvasId] = chart;
      return chart;
    },

    initAll() {
      // Dashboard charts
      this.createLineChart('chart-dash-level', [
        { label: 'Ketinggian Air (%)', data: [], borderColor: '#2378A8', backgroundColor: 'rgba(35,120,168,0.08)', fill: true }
      ], '%');

      this.createLineChart('chart-dash-flow', [
        { label: 'Inlet (L/m)', data: [], borderColor: '#2378A8', fill: false },
        { label: 'Outlet (L/m)', data: [], borderColor: '#38866A', fill: false }
      ], '');

      this.createLineChart('chart-dash-quality', [
        { label: 'Turbidity (NTU)', data: [], borderColor: '#D69A38', fill: false },
        { label: 'TDS / 100 (x100 ppm)', data: [], borderColor: '#2378A8', fill: false }
      ], '');

      // Tandon monitoring charts
      this.createLineChart('chart-tandon-level', [
        { label: 'Ketinggian Air (%)', data: [], borderColor: '#2378A8', backgroundColor: 'rgba(35,120,168,0.08)', fill: true }
      ], '%');

      this.createLineChart('chart-tandon-flow', [
        { label: 'Debit Inlet (L/min)', data: [], borderColor: '#2378A8', backgroundColor: 'rgba(35,120,168,0.08)', fill: true },
        { label: 'Debit Outlet (L/min)', data: [], borderColor: '#38866A', backgroundColor: 'rgba(56,134,106,0.06)', fill: true }
      ], 'L/m');

      // Water quality 5 charts
      this.createLineChart('chart-wq-turbidity', [{ label: 'Turbidity (NTU)', data: [], borderColor: '#2378A8', fill: false }], '');
      this.createLineChart('chart-wq-tds', [{ label: 'TDS (ppm)', data: [], borderColor: '#185B83', fill: false }], '');
      this.createLineChart('chart-wq-ph', [{ label: 'pH', data: [], borderColor: '#38866A', fill: false }], '');
      this.createLineChart('chart-wq-ec', [{ label: 'EC (µS/cm)', data: [], borderColor: '#2378A8', fill: false }], '');
      this.createLineChart('chart-wq-temp', [{ label: 'Suhu (°C)', data: [], borderColor: '#D69A38', fill: false }], '');

      // Septic gas 3 charts
      this.createLineChart('chart-gas-h2s', [{ label: 'H₂S (ppm)', data: [], borderColor: '#D69A38', fill: false }], '');
      this.createLineChart('chart-gas-ch4', [{ label: 'CH₄ (%LEL)', data: [], borderColor: '#C85C55', fill: false }], '');
      this.createLineChart('chart-gas-nh3', [{ label: 'NH₃ (ppm)', data: [], borderColor: '#2378A8', fill: false }], '');

      // History 8 charts
      this.createLineChart('chart-hist-level', [{ label: 'Level (%)', data: [], borderColor: '#2378A8', fill: true, backgroundColor: 'rgba(35,120,168,0.08)' }], '%');
      this.createLineChart('chart-hist-flow', [
        { label: 'Inlet (L/m)', data: [], borderColor: '#2378A8', fill: false },
        { label: 'Outlet (L/m)', data: [], borderColor: '#38866A', fill: false }
      ], '');
      this.createLineChart('chart-hist-turbidity', [{ label: 'Turbidity (NTU)', data: [], borderColor: '#D69A38', fill: false }], '');
      this.createLineChart('chart-hist-tds', [{ label: 'TDS (ppm)', data: [], borderColor: '#185B83', fill: false }], '');
      this.createLineChart('chart-hist-ph', [{ label: 'pH', data: [], borderColor: '#38866A', fill: false }], '');
      this.createLineChart('chart-hist-ec', [{ label: 'EC (µS/cm)', data: [], borderColor: '#2378A8', fill: false }], '');
      this.createLineChart('chart-hist-temp', [{ label: 'Suhu (°C)', data: [], borderColor: '#D69A38', fill: false }], '');
      this.createLineChart('chart-hist-gas', [
        { label: 'H₂S (ppm)', data: [], borderColor: '#D69A38', fill: false },
        { label: 'CH₄ (%LEL)', data: [], borderColor: '#C85C55', fill: false },
        { label: 'NH₃ (ppm)', data: [], borderColor: '#2378A8', fill: false }
      ], '');
    },

    updateAll() {
      const live = SensorStore.liveSeries;
      const liveLabels = live.map((p) => formatTimeShort(p.timestamp));

      const setChart = (id, labels, seriesArrays) => {
        const ch = this.charts[id];
        if (!ch) return;
        ch.data.labels = labels;
        seriesArrays.forEach((arr, idx) => {
          if (ch.data.datasets[idx]) ch.data.datasets[idx].data = arr;
        });
        ch.update('none');
      };

      // Live charts
      setChart('chart-dash-level', liveLabels, [live.map((p) => p.detectedLevelPct)]);
      setChart('chart-dash-flow', liveLabels, [live.map((p) => +p.inletFlow.toFixed(1)), live.map((p) => +p.outletFlow.toFixed(1))]);
      setChart('chart-dash-quality', liveLabels, [live.map((p) => +p.turbidity.toFixed(2)), live.map((p) => +(p.tds / 100).toFixed(2))]);

      // Tandon charts (respects selected range: 1h, 24h, 7d, 30d)
      const tandonSeries = SensorStore.archives[SensorStore.tandonRange] || live;
      const tandonLabels = tandonSeries.map((p) => formatHistoryLabel(p.timestamp, SensorStore.tandonRange));
      setChart('chart-tandon-level', tandonLabels, [tandonSeries.map((p) => p.detectedLevelPct)]);
      setChart('chart-tandon-flow', tandonLabels, [tandonSeries.map((p) => +p.inletFlow.toFixed(1)), tandonSeries.map((p) => +p.outletFlow.toFixed(1))]);

      setChart('chart-wq-turbidity', liveLabels, [live.map((p) => +p.turbidity.toFixed(2))]);
      setChart('chart-wq-tds', liveLabels, [live.map((p) => p.tds)]);
      setChart('chart-wq-ph', liveLabels, [live.map((p) => +p.ph.toFixed(2))]);
      setChart('chart-wq-ec', liveLabels, [live.map((p) => Math.round(p.ec))]);
      setChart('chart-wq-temp', liveLabels, [live.map((p) => +p.temperature.toFixed(1))]);

      setChart('chart-gas-h2s', liveLabels, [live.map((p) => +p.gasH2S.toFixed(1))]);
      setChart('chart-gas-ch4', liveLabels, [live.map((p) => +p.gasCH4.toFixed(1))]);
      setChart('chart-gas-nh3', liveLabels, [live.map((p) => +p.gasNH3.toFixed(1))]);

      // History charts
      const hist = SensorStore.archives[SensorStore.historyRange] || [];
      const histLabels = hist.map((p) => formatHistoryLabel(p.timestamp, SensorStore.historyRange));
      setChart('chart-hist-level', histLabels, [hist.map((p) => p.detectedLevelPct)]);
      setChart('chart-hist-flow', histLabels, [hist.map((p) => +p.inletFlow.toFixed(1)), hist.map((p) => +p.outletFlow.toFixed(1))]);
      setChart('chart-hist-turbidity', histLabels, [hist.map((p) => +p.turbidity.toFixed(2))]);
      setChart('chart-hist-tds', histLabels, [hist.map((p) => p.tds)]);
      setChart('chart-hist-ph', histLabels, [hist.map((p) => +p.ph.toFixed(2))]);
      setChart('chart-hist-ec', histLabels, [hist.map((p) => Math.round(p.ec))]);
      setChart('chart-hist-temp', histLabels, [hist.map((p) => +p.temperature.toFixed(1))]);
      setChart('chart-hist-gas', histLabels, [
        hist.map((p) => +p.gasH2S.toFixed(1)),
        hist.map((p) => +p.gasCH4.toFixed(1)),
        hist.map((p) => +p.gasNH3.toFixed(1))
      ]);
    }
  };

  // ------------------------------------------------------------------------
  // 5. UI RENDERER
  // ------------------------------------------------------------------------
  const UIRenderer = {
    applyBadge(el, statusObj) {
      if (!el || !statusObj) return;
      el.className = `status-badge status-${statusObj.code}`;
      el.textContent = statusObj.label;
    },

    renderAll(evalResult) {
      const c = SensorStore.current;
      const cfg = SensorStore.config;
      const errSensor = cfg.simulatedErrorSensor;

      // Header & Sidebar status
      const online = cfg.deviceOnline;
      const devBadge = document.getElementById('header-device-badge');
      const devText = document.getElementById('header-device-text');
      devBadge.className = `pill-badge ${online ? 'online' : 'offline'}`;
      devBadge.querySelector('.dot').className = `dot ${online ? 'dot-success' : 'dot-danger'}`;
      devText.textContent = online ? 'Online' : 'Offline';

      const simDot = document.getElementById('sidebar-sim-dot');
      const simLabel = document.getElementById('sidebar-sim-label');
      simDot.className = `dot ${SensorStore.simulationRunning ? 'dot-success' : 'dot-warning'}`;
      simLabel.textContent = SensorStore.simulationRunning ? 'Simulasi Berjalan' : 'Simulasi Dijeda';
      document.getElementById('sidebar-interval-label').textContent = `${(cfg.simIntervalMs / 1000).toFixed(1)}s`;

      const quickPlayText = document.getElementById('dash-quick-play-text');
      if (quickPlayText) quickPlayText.textContent = SensorStore.simulationRunning ? 'Jeda Simulasi' : 'Lanjut Simulasi';

      // Continuous ultrasonic tank metrics
      const tm = evalResult.tankMetrics;
      const levelPctRounded = tm.valid ? Math.round(tm.levelPct) : 0;
      const estVolL = tm.valid ? Math.round(tm.volumeL) : 0;

      // --- Dashboard KPIs ---
      document.getElementById('kpi-water-pct').textContent = tm.valid ? levelPctRounded : '--';
      document.getElementById('kpi-water-vol').textContent = tm.valid
        ? `Estimasi ~${estVolL.toLocaleString('id-ID')} L / ${cfg.tankCapacityL.toLocaleString('id-ID')} L`
        : 'Data level tidak tersedia';
      document.getElementById('kpi-water-tier').textContent = tm.valid
        ? `Tinggi ${tm.heightCm.toFixed(1)} cm`
        : evalResult.waterStatus.label;
      this.applyBadge(document.getElementById('kpi-water-badge'), evalResult.waterStatus);

      document.getElementById('kpi-turbidity').textContent = errSensor === 'turbidity' ? 'ERR' : c.turbidity.toFixed(1);
      document.getElementById('kpi-tds').textContent = errSensor === 'ec' ? 'ERR' : c.tds;
      document.getElementById('kpi-ph').textContent = errSensor === 'ph' ? 'ERR' : c.ph.toFixed(1);
      this.applyBadge(document.getElementById('kpi-quality-badge'), evalResult.worstQuality);

      const septicEstVol = Math.round((c.septicLevel / 100) * cfg.septicCapacityL);
      document.getElementById('kpi-septic-pct').textContent = Math.round(c.septicLevel);
      document.getElementById('kpi-septic-vol').textContent = `Estimasi ~${septicEstVol.toLocaleString('id-ID')} L`;
      document.getElementById('kpi-septic-h2s').textContent = errSensor === 'h2s' ? 'ERR' : c.gasH2S.toFixed(1);
      this.applyBadge(document.getElementById('kpi-septic-badge'), evalResult.worstSeptic);

      document.getElementById('kpi-sensors-active').textContent = online ? evalResult.activeSensors : 0;
      document.getElementById('kpi-last-update').textContent = formatTimeShort(c.timestamp);
      this.applyBadge(document.getElementById('kpi-sys-badge'), online ? { code: 'normal', label: 'Online' } : { code: 'danger', label: 'Offline' });

      // --- Page 2: Monitoring Tandon (Ultrasonik Kontinu) ---
      document.getElementById('tandon-last-update').textContent = formatTimeShort(c.timestamp);
      document.getElementById('tandon-max-cap-label').textContent = cfg.tankCapacityL.toLocaleString('id-ID');
      document.getElementById('tandon-max-vol').textContent = `${cfg.tankCapacityL.toLocaleString('id-ID')} L`;
      document.getElementById('tandon-max-vol-box').textContent = `${cfg.tankCapacityL.toLocaleString('id-ID')} L`;
      document.getElementById('tandon-ref-height-label').textContent = cfg.tankRefHeightCm;
      this.applyBadge(document.getElementById('tandon-status-badge'), evalResult.waterStatus);

      document.getElementById('tandon-visual-pct').textContent = tm.valid ? `${levelPctRounded}%` : 'ERR';
      document.getElementById('tandon-detected-pct').textContent = tm.valid ? `${levelPctRounded}%` : '--';
      document.getElementById('tandon-est-vol').textContent = tm.valid ? `${estVolL.toLocaleString('id-ID')} L` : '--';
      document.getElementById('tandon-visual-dist').textContent = tm.valid ? `${Math.round(tm.distanceCm)} cm` : 'ERR';

      const levelNoteEl = document.getElementById('tandon-level-note');
      if (!online) {
        levelNoteEl.textContent = 'Perangkat tidak terhubung';
      } else if (!tm.valid) {
        levelNoteEl.textContent = tm.reason === 'blind_zone' ? 'Di dalam blind zone sensor' : 'Pembacaan sensor tidak valid';
      } else if (evalResult.waterStatus.label === 'Rendah') {
        levelNoteEl.textContent = 'Volume air perlu diperhatikan';
      } else if (evalResult.waterStatus.label === 'Penuh') {
        levelNoteEl.textContent = 'Mendekati kapasitas maksimum';
      } else {
        levelNoteEl.textContent = 'Kondisi air mencukupi';
      }

      const waterFillEl = document.getElementById('tandon-water-fill');
      const beamZoneEl = document.getElementById('tandon-beam-zone');
      const visualHeightPct = tm.valid ? Math.max(0, Math.min(100, tm.levelPct)) : 0;
      waterFillEl.style.height = `${visualHeightPct}%`;
      beamZoneEl.style.height = `${100 - visualHeightPct}%`;
      waterFillEl.style.backgroundColor = !tm.valid
        ? '#94A3B0'
        : evalResult.waterStatus.label === 'Rendah'
          ? '#D69A38'
          : '#2378A8';

      const fillStatusEl = document.getElementById('tandon-fill-status');
      const fillSubEl = document.getElementById('tandon-fill-sub');
      if (!online) {
        fillStatusEl.textContent = 'Offline';
        fillSubEl.textContent = 'Menunggu koneksi perangkat';
      } else if (!tm.valid) {
        fillStatusEl.textContent = 'Sensor Error';
        fillSubEl.textContent = 'Periksa sensor ultrasonik';
      } else if (c.inletFlow > 0.5) {
        fillStatusEl.textContent = 'Mengisi';
        fillSubEl.textContent = `Debit masuk ${c.inletFlow.toFixed(1)} L/min`;
      } else if (tm.levelPct >= cfg.tankHighWarnPct) {
        fillStatusEl.textContent = 'Penuh';
        fillSubEl.textContent = 'Katup inlet tertutup';
      } else {
        fillStatusEl.textContent = evalResult.waterStatus.label;
        fillSubEl.textContent = 'Pompa inlet siaga';
      }

      // Ultrasonic Sensor Card
      this.applyBadge(document.getElementById('us-sensor-badge'), evalResult.ultrasonicStatus);
      this.applyBadge(document.getElementById('us-sensor-state-badge'), evalResult.ultrasonicStatus);
      document.getElementById('us-blind-zone-label').textContent = cfg.ultrasonicBlindZoneCm;
      document.getElementById('us-ref-height-label').textContent = cfg.tankRefHeightCm;

      if (!online) {
        document.getElementById('us-distance-val').textContent = '-- cm';
        document.getElementById('us-height-val').textContent = '-- cm';
        document.getElementById('us-pct-val').textContent = '--%';
        document.getElementById('us-sensor-sub').textContent = 'Perangkat offline';
      } else if (!tm.valid) {
        document.getElementById('us-distance-val').textContent = tm.distanceCm !== null ? `${tm.distanceCm.toFixed(1)} cm` : 'ERR';
        document.getElementById('us-height-val').textContent = 'ERR';
        document.getElementById('us-pct-val').textContent = 'ERR';
        document.getElementById('us-sensor-sub').textContent = tm.reason === 'blind_zone' ? 'Melewati batas blind zone' : 'Sinyal tidak valid';
      } else {
        document.getElementById('us-distance-val').textContent = `${tm.distanceCm.toFixed(1)} cm`;
        document.getElementById('us-height-val').textContent = `${tm.heightCm.toFixed(1)} cm`;
        document.getElementById('us-pct-val').textContent = `${tm.levelPct.toFixed(1)}%`;
        document.getElementById('us-sensor-sub').textContent = 'Pembacaan valid';
      }

      const tandonRangeLabels = { '1h': '1 Jam Terakhir', '24h': '24 Jam Terakhir', '7d': '7 Hari Terakhir', '30d': '30 Hari Terakhir' };
      const tandonLbl = document.getElementById('tandon-chart-range-label');
      if (tandonLbl) tandonLbl.textContent = `Rentang: ${tandonRangeLabels[SensorStore.tandonRange]}`;

      // Flow INLET & OUTLET
      document.getElementById('inlet-flow-rate').textContent = c.inletFlow.toFixed(1);
      document.getElementById('inlet-total-vol').textContent = c.inletTotalL.toFixed(1);
      this.applyBadge(document.getElementById('inlet-status-badge'), c.inletFlow > 0.3 ? { code: 'info', label: 'Mengalir' } : { code: 'error', label: 'Diam' });

      document.getElementById('outlet-flow-rate').textContent = c.outletFlow.toFixed(1);
      document.getElementById('outlet-total-vol').textContent = c.outletTotalL.toFixed(1);
      this.applyBadge(document.getElementById('outlet-status-badge'), c.outletFlow > 0.3 ? { code: 'info', label: 'Mengalir' } : { code: 'error', label: 'Diam' });

      // --- Page 3: Water Quality ---
      document.getElementById('wq-factor-label').textContent = cfg.ecToTdsFactor.toFixed(2);
      document.getElementById('wq-turbidity-val').textContent = errSensor === 'turbidity' ? 'ERR' : c.turbidity.toFixed(1);
      this.applyBadge(document.getElementById('wq-turbidity-badge'), evalResult.turbStatus);

      document.getElementById('wq-tds-val').textContent = errSensor === 'ec' ? 'ERR' : c.tds;
      this.applyBadge(document.getElementById('wq-tds-badge'), evalResult.tdsStatus);

      document.getElementById('wq-ph-val').textContent = errSensor === 'ph' ? 'ERR' : c.ph.toFixed(1);
      this.applyBadge(document.getElementById('wq-ph-badge'), evalResult.phStatus);

      document.getElementById('wq-ec-val').textContent = errSensor === 'ec' ? 'ERR' : Math.round(c.ec);
      this.applyBadge(document.getElementById('wq-ec-badge'), evalResult.ecStatus);

      document.getElementById('wq-temp-val').textContent = c.temperature.toFixed(1);
      this.applyBadge(document.getElementById('wq-temp-badge'), evalResult.tempStatus);

      // --- Page 4: Sanitasi / Septic Tank ---
      const septicPct = Math.round(c.septicLevel);
      const septicHeightCm = Math.round((c.septicLevel / 100) * cfg.septicHeightCm);
      document.getElementById('septic-max-cap-label').textContent = cfg.septicCapacityL.toLocaleString('id-ID');
      document.getElementById('septic-max-height-label').textContent = cfg.septicHeightCm;
      document.getElementById('septic-vol-max').textContent = cfg.septicCapacityL.toLocaleString('id-ID');
      document.getElementById('septic-height-max').textContent = cfg.septicHeightCm;

      document.getElementById('septic-visual-pct').textContent = `${septicPct}%`;
      document.getElementById('septic-pct-val').textContent = `${septicPct}%`;
      document.getElementById('septic-vol-val').textContent = `~${septicEstVol.toLocaleString('id-ID')} L`;
      document.getElementById('septic-height-val').textContent = `${septicHeightCm} cm`;
      this.applyBadge(document.getElementById('septic-status-badge'), evalResult.septicTankStatus);

      const septicFill = document.getElementById('septic-fill-bar');
      septicFill.style.height = `${septicPct}%`;
      septicFill.className = `septic-fill ${evalResult.septicTankStatus.code === 'danger' ? 'danger' : evalResult.septicTankStatus.code === 'warning' ? 'warning' : ''}`;

      const actText = document.getElementById('septic-action-text');
      const actSub = document.getElementById('septic-action-sub');
      if (evalResult.septicTankStatus.code === 'danger') {
        actText.textContent = 'Segera Lakukan Penyedotan';
        actSub.textContent = 'Kapasitas kritis (>= 90%)';
      } else if (evalResult.septicTankStatus.code === 'warning') {
        actText.textContent = 'Jadwalkan Penyedotan';
        actSub.textContent = 'Mendekati batas maksimal';
      } else {
        actText.textContent = 'Belum perlu sedot';
        actSub.textContent = 'Kapasitas aman';
      }

      document.getElementById('gas-h2s-val').textContent = errSensor === 'h2s' ? 'ERR' : c.gasH2S.toFixed(1);
      document.getElementById('gas-h2s-sensor-state').textContent = errSensor === 'h2s' ? 'Sensor: Error / Tidak Merespons' : 'Sensor: Aktif';
      this.applyBadge(document.getElementById('gas-h2s-badge'), evalResult.h2sStatus);

      document.getElementById('gas-ch4-val').textContent = c.gasCH4.toFixed(1);
      this.applyBadge(document.getElementById('gas-ch4-badge'), evalResult.ch4Status);

      document.getElementById('gas-nh3-val').textContent = c.gasNH3.toFixed(1);
      this.applyBadge(document.getElementById('gas-nh3-badge'), evalResult.nh3Status);

      const septicSummary = document.getElementById('septic-sensor-summary');
      septicSummary.innerHTML = [
        { name: 'Sensor Level Ultrasonik Septik', state: online ? 'Aktif' : 'Offline', code: online ? 'normal' : 'danger' },
        { name: 'Sensor Gas H₂S', state: errSensor === 'h2s' ? 'Sensor Error' : 'Aktif', code: errSensor === 'h2s' ? 'error' : 'normal' },
        { name: 'Sensor Gas CH₄ (%LEL)', state: online ? 'Aktif' : 'Offline', code: online ? 'normal' : 'danger' },
        { name: 'Sensor Gas NH₃', state: online ? 'Aktif' : 'Offline', code: online ? 'normal' : 'danger' }
      ].map((item) => `
        <div class="metric-box" style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:12.5px; font-weight:500;">${item.name}</span>
          <span class="status-badge status-${item.code}">${item.state}</span>
        </div>
      `).join('');

      // --- Notifications & History Table ---
      this.renderNotifications();
      this.renderHistoryTable();
    },

    renderNotifications() {
      const unread = SensorStore.notifications.filter((n) => !n.read).length;
      const badge = document.getElementById('notif-badge');
      badge.textContent = unread;
      badge.classList.toggle('hidden', unread === 0);

      const renderList = (containerId, items) => {
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!items.length) {
          el.innerHTML = '<div style="font-size:12.5px; color:var(--text-muted); padding:10px 0;">Tidak ada notifikasi pada kategori ini.</div>';
          return;
        }
        el.innerHTML = items.map((n) => {
          const catLabel = n.category === 'danger' ? 'Bahaya' : n.category === 'warning' ? 'Peringatan' : 'Informasi';
          const badgeClass = n.category === 'danger' ? 'status-danger' : n.category === 'warning' ? 'status-warning' : 'status-info';
          return `
            <div class="notif-item cat-${n.category} ${n.read ? '' : 'unread'}">
              <div class="notif-body">
                <div class="notif-top">
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span class="status-badge ${badgeClass}">${catLabel}</span>
                    <span class="notif-title">${n.title}</span>
                  </div>
                  <span class="notif-time tabular-nums">${formatTimeShort(n.timestamp)}</span>
                </div>
                <p class="notif-msg">${n.message}</p>
              </div>
            </div>
          `;
        }).join('');
      };

      renderList('dash-notif-list', SensorStore.notifications.slice(0, 4));
      const filtered = SensorStore.notifFilter === 'all'
        ? SensorStore.notifications
        : SensorStore.notifications.filter((n) => n.category === SensorStore.notifFilter);
      renderList('drawer-notif-list', filtered);
    },

    renderHistoryTable() {
      const tbody = document.getElementById('history-table-body');
      if (!tbody) return;
      const rows = (SensorStore.archives[SensorStore.historyRange] || []).slice().reverse().slice(0, 20);
      const rangeLabels = { '1h': '1 Jam Terakhir', '24h': '24 Jam Terakhir', '7d': '7 Hari Terakhir', '30d': '30 Hari Terakhir' };
      const lbl = document.getElementById('hist-range-label-1');
      if (lbl) lbl.textContent = `Rentang: ${rangeLabels[SensorStore.historyRange]}`;

      tbody.innerHTML = rows.map((r) => {
        const isWarn = r.turbidity >= SensorStore.config.turbidityWarn || r.septicLevel >= SensorStore.config.septicWarn || r.detectedLevelPct <= 25;
        return `
          <tr class="tabular-nums">
            <td>${formatHistoryLabel(r.timestamp, SensorStore.historyRange)}</td>
            <td>${r.detectedLevelPct}%</td>
            <td>${r.inletFlow.toFixed(1)}</td>
            <td>${r.outletFlow.toFixed(1)}</td>
            <td>${r.turbidity.toFixed(1)}</td>
            <td>${r.tds}</td>
            <td>${r.ph.toFixed(1)}</td>
            <td>${Math.round(r.ec)}</td>
            <td>${r.temperature.toFixed(1)}</td>
            <td>${Math.round(r.septicLevel)}%</td>
            <td>${r.gasH2S.toFixed(1)}</td>
            <td>${r.gasCH4.toFixed(1)}</td>
            <td><span class="status-badge ${isWarn ? 'status-warning' : 'status-normal'}">${isWarn ? 'Perhatian' : 'Normal'}</span></td>
          </tr>
        `;
      }).join('');
    },

    syncSlidersFromState() {
      const c = SensorStore.current;
      const setVal = (id, val, labelId, suffix = '') => {
        const el = document.getElementById(id);
        const lbl = document.getElementById(labelId);
        if (el) el.value = val;
        if (lbl) lbl.textContent = `${val}${suffix}`;
      };
      setVal('slider-level', Math.round(c.waterLevelRaw), 'val-slider-level', '%');
      setVal('slider-turbidity', c.turbidity.toFixed(1), 'val-slider-turbidity', ' NTU');
      setVal('slider-ec', Math.round(c.ec), 'val-slider-ec', ' µS/cm');
      setVal('slider-tds', Math.round(c.tds), 'val-slider-tds', ' ppm');
      setVal('slider-ph', c.ph.toFixed(1), 'val-slider-ph', '');
      setVal('slider-temp', c.temperature.toFixed(1), 'val-slider-temp', ' °C');
      setVal('slider-septic', Math.round(c.septicLevel), 'val-slider-septic', '%');
      setVal('slider-gas', c.gasH2S.toFixed(1), 'val-slider-gas', ' ppm');
    }
  };

  // ------------------------------------------------------------------------
  // 6. EVENT CONTROLLER & APP ORCHESTRATION
  // ------------------------------------------------------------------------
  const App = {
    refreshAll() {
      const evalResult = StatusEvaluator.evaluate();
      StatusEvaluator.checkAndNotify(evalResult);
      UIRenderer.renderAll(evalResult);
      ChartManager.updateAll();
    }
  };

  function setupNavigation() {
    const navButtons = document.querySelectorAll('.nav-item[data-page]');
    const pages = document.querySelectorAll('.page-view');
    const titleEl = document.getElementById('topbar-title');
    const pageTitles = {
      dashboard: 'Selamat datang di Griya Sehati',
      tandon: 'Monitoring Tandon Air',
      kualitas: 'Pemantauan Kualitas Air',
      sanitasi: 'Monitoring Sanitasi & Tangki Septik',
      riwayat: 'Riwayat Data & Analitik',
      pengaturan: 'Pengaturan Sistem'
    };

    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-page');
        SensorStore.activePage = target;
        navButtons.forEach((b) => b.classList.toggle('active', b === btn));
        pages.forEach((p) => p.classList.toggle('active', p.id === `page-${target}`));
        titleEl.textContent = pageTitles[target] || 'Griya Sehati';
        closeAllDrawers();
        ChartManager.updateAll();
      });
    });
  }

  function closeAllDrawers() {
    document.getElementById('sim-drawer').classList.remove('open');
    document.getElementById('notif-drawer').classList.remove('open');
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('drawer-backdrop').classList.remove('open');
  }

  function setupDrawers() {
    const backdrop = document.getElementById('drawer-backdrop');
    const simDrawer = document.getElementById('sim-drawer');
    const notifDrawer = document.getElementById('notif-drawer');
    const sidebar = document.getElementById('sidebar');

    const openDrawer = (el) => {
      closeAllDrawers();
      el.classList.add('open');
      backdrop.classList.add('open');
    };

    document.getElementById('btn-open-sim').addEventListener('click', () => {
      UIRenderer.syncSlidersFromState();
      openDrawer(simDrawer);
    });
    document.getElementById('btn-open-sim-sidebar').addEventListener('click', () => {
      UIRenderer.syncSlidersFromState();
      openDrawer(simDrawer);
    });
    document.getElementById('btn-open-notif').addEventListener('click', () => openDrawer(notifDrawer));
    document.getElementById('dash-view-all-notif').addEventListener('click', () => openDrawer(notifDrawer));
    document.getElementById('mobile-menu-btn').addEventListener('click', () => openDrawer(sidebar));

    document.getElementById('btn-close-sim').addEventListener('click', closeAllDrawers);
    document.getElementById('btn-close-notif').addEventListener('click', closeAllDrawers);
    backdrop.addEventListener('click', closeAllDrawers);
  }

  function setupSimulationControls() {
    document.getElementById('sim-start-btn').addEventListener('click', () => {
      SimulationEngine.start();
      App.refreshAll();
    });
    document.getElementById('sim-pause-btn').addEventListener('click', () => {
      SimulationEngine.pause();
      App.refreshAll();
    });
    document.getElementById('sim-reset-btn').addEventListener('click', () => {
      SimulationEngine.reset();
      UIRenderer.syncSlidersFromState();
    });
    document.getElementById('dash-quick-play').addEventListener('click', () => {
      if (SensorStore.simulationRunning) SimulationEngine.pause();
      else SimulationEngine.start();
      App.refreshAll();
    });

    const presetBtns = [
      { id: 'preset-normal-btn', key: 'normal' },
      { id: 'preset-warning-btn', key: 'warning' },
      { id: 'preset-danger-btn', key: 'danger' }
    ];
    presetBtns.forEach(({ id, key }) => {
      document.getElementById(id).addEventListener('click', () => {
        presetBtns.forEach((b) => document.getElementById(b.id).classList.toggle('active', b.key === key));
        SimulationEngine.applyPreset(key);
        UIRenderer.syncSlidersFromState();
      });
    });

    // Live sliders
    const bindSlider = (id, onInput) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => {
        onInput(parseFloat(e.target.value));
        SensorStore.pushSnapshot(SensorStore.current);
        App.refreshAll();
      });
    };

    bindSlider('slider-level', (v) => {
      SensorStore.current.waterLevelRaw = v;
      SensorStore.targets.waterLevelRaw = v;
      SensorStore.current.ultrasonicDistanceCm = +(SensorStore.config.tankRefHeightCm * (1 - v / 100)).toFixed(1);
      document.getElementById('val-slider-level').textContent = `${Math.round(v)}%`;
    });

    bindSlider('slider-turbidity', (v) => {
      SensorStore.current.turbidity = v;
      SensorStore.targets.turbidity = v;
      document.getElementById('val-slider-turbidity').textContent = `${v.toFixed(1)} NTU`;
    });

    bindSlider('slider-ec', (v) => {
      SensorStore.current.ec = v;
      SensorStore.targets.ec = v;
      SensorStore.current.tds = Math.round(v * SensorStore.config.ecToTdsFactor);
      document.getElementById('val-slider-ec').textContent = `${Math.round(v)} µS/cm`;
      document.getElementById('slider-tds').value = SensorStore.current.tds;
      document.getElementById('val-slider-tds').textContent = `${SensorStore.current.tds} ppm`;
    });

    bindSlider('slider-tds', (v) => {
      const derivedEc = Math.round(v / SensorStore.config.ecToTdsFactor);
      SensorStore.current.tds = Math.round(v);
      SensorStore.current.ec = derivedEc;
      SensorStore.targets.ec = derivedEc;
      document.getElementById('val-slider-tds').textContent = `${Math.round(v)} ppm`;
      document.getElementById('slider-ec').value = derivedEc;
      document.getElementById('val-slider-ec').textContent = `${derivedEc} µS/cm`;
    });

    bindSlider('slider-ph', (v) => {
      SensorStore.current.ph = v;
      SensorStore.targets.ph = v;
      document.getElementById('val-slider-ph').textContent = v.toFixed(1);
    });

    bindSlider('slider-temp', (v) => {
      SensorStore.current.temperature = v;
      SensorStore.targets.temperature = v;
      document.getElementById('val-slider-temp').textContent = `${v.toFixed(1)} °C`;
    });

    bindSlider('slider-septic', (v) => {
      SensorStore.current.septicLevel = v;
      SensorStore.targets.septicLevel = v;
      document.getElementById('val-slider-septic').textContent = `${Math.round(v)}%`;
    });

    bindSlider('slider-gas', (v) => {
      SensorStore.current.gasH2S = v;
      SensorStore.targets.gasH2S = v;
      SensorStore.current.gasCH4 = +(v * 1.15).toFixed(1);
      SensorStore.targets.gasCH4 = SensorStore.current.gasCH4;
      SensorStore.current.gasNH3 = +(v * 1.35).toFixed(1);
      SensorStore.targets.gasNH3 = SensorStore.current.gasNH3;
      document.getElementById('val-slider-gas').textContent = `${v.toFixed(1)} ppm`;
    });
  }

  function setupHistoryAndNotifications() {
    document.querySelectorAll('#tandon-range-group button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tandon-range-group button').forEach((b) => b.classList.toggle('active', b === btn));
        SensorStore.tandonRange = btn.getAttribute('data-range');
        App.refreshAll();
      });
    });

    document.querySelectorAll('#history-filter-group button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#history-filter-group button').forEach((b) => b.classList.toggle('active', b === btn));
        SensorStore.historyRange = btn.getAttribute('data-range');
        UIRenderer.renderHistoryTable();
        ChartManager.updateAll();
      });
    });

    document.getElementById('btn-export-csv').addEventListener('click', () => {
      const rows = SensorStore.archives[SensorStore.historyRange] || [];
      const header = ['Timestamp', 'Level_Pct', 'Inlet_L_min', 'Outlet_L_min', 'Turbidity_NTU', 'TDS_ppm', 'pH', 'EC_uS_cm', 'Temp_C', 'Septic_Pct', 'H2S_ppm', 'CH4_LEL', 'NH3_ppm'];
      const csvLines = [header.join(',')];
      rows.forEach((r) => {
        csvLines.push([
          r.timestamp.toISOString(),
          r.detectedLevelPct,
          r.inletFlow.toFixed(2),
          r.outletFlow.toFixed(2),
          r.turbidity.toFixed(2),
          r.tds,
          r.ph.toFixed(2),
          Math.round(r.ec),
          r.temperature.toFixed(1),
          Math.round(r.septicLevel),
          r.gasH2S.toFixed(2),
          r.gasCH4.toFixed(2),
          r.gasNH3.toFixed(2)
        ].join(','));
      });
      const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `griya-sehati-riwayat-${SensorStore.historyRange}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    document.querySelectorAll('#notif-filter-group button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#notif-filter-group button').forEach((b) => b.classList.toggle('active', b === btn));
        SensorStore.notifFilter = btn.getAttribute('data-cat');
        UIRenderer.renderNotifications();
      });
    });

    document.getElementById('btn-mark-all-read').addEventListener('click', () => {
      SensorStore.notifications.forEach((n) => { n.read = true; });
      UIRenderer.renderNotifications();
    });
  }

  function setupSettings() {
    document.getElementById('btn-save-settings').addEventListener('click', () => {
      const cfg = SensorStore.config;
      cfg.tankCapacityL = Math.max(250, parseInt(document.getElementById('cfg-tank-cap').value, 10) || 1000);
      cfg.tankRefHeightCm = Math.max(60, parseInt(document.getElementById('cfg-tank-ref-height').value, 10) || 120);
      cfg.tankLowWarnPct = Math.max(5, Math.min(45, parseInt(document.getElementById('cfg-tank-low-warn').value, 10) || 25));
      cfg.tankHighWarnPct = Math.max(70, Math.min(98, parseInt(document.getElementById('cfg-tank-high-warn').value, 10) || 85));
      cfg.septicCapacityL = Math.max(500, parseInt(document.getElementById('cfg-septic-cap').value, 10) || 2000);
      cfg.septicHeightCm = Math.max(80, parseInt(document.getElementById('cfg-septic-height').value, 10) || 150);
      cfg.ecToTdsFactor = Math.max(0.45, Math.min(0.75, parseFloat(document.getElementById('cfg-tds-factor').value) || 0.50));
      cfg.turbidityWarn = parseFloat(document.getElementById('cfg-turb-warn').value) || 5.0;
      cfg.tdsWarn = parseFloat(document.getElementById('cfg-tds-warn').value) || 500;
      cfg.phMin = parseFloat(document.getElementById('cfg-ph-min').value) || 6.5;
      cfg.phMax = parseFloat(document.getElementById('cfg-ph-max').value) || 8.5;
      cfg.simIntervalMs = parseInt(document.getElementById('cfg-sim-interval').value, 10) || 2500;
      cfg.deviceOnline = document.getElementById('cfg-device-online').value === 'online';
      cfg.simulatedErrorSensor = document.getElementById('cfg-sensor-error').value;

      SensorStore.current.ultrasonicDistanceCm = +(cfg.tankRefHeightCm * (1 - SensorStore.current.waterLevelRaw / 100)).toFixed(1);
      SensorStore.current.tds = Math.round(SensorStore.current.ec * cfg.ecToTdsFactor);
      if (SensorStore.simulationRunning) SimulationEngine.start();
      StatusEvaluator.emitNotification('cfg_saved', 'info', 'Pengaturan Diterapkan', 'Konfigurasi tandon, ambang batas, dan parameter simulasi diperbarui.');
      App.refreshAll();
    });

    document.getElementById('btn-reset-settings').addEventListener('click', () => {
      SensorStore.config = { ...DEFAULT_CONFIG };
      document.getElementById('cfg-tank-cap').value = DEFAULT_CONFIG.tankCapacityL;
      document.getElementById('cfg-tank-ref-height').value = DEFAULT_CONFIG.tankRefHeightCm;
      document.getElementById('cfg-tank-low-warn').value = DEFAULT_CONFIG.tankLowWarnPct;
      document.getElementById('cfg-tank-high-warn').value = DEFAULT_CONFIG.tankHighWarnPct;
      document.getElementById('cfg-septic-cap').value = DEFAULT_CONFIG.septicCapacityL;
      document.getElementById('cfg-septic-height').value = DEFAULT_CONFIG.septicHeightCm;
      document.getElementById('cfg-tds-factor').value = DEFAULT_CONFIG.ecToTdsFactor;
      document.getElementById('cfg-turb-warn').value = DEFAULT_CONFIG.turbidityWarn;
      document.getElementById('cfg-tds-warn').value = DEFAULT_CONFIG.tdsWarn;
      document.getElementById('cfg-ph-min').value = DEFAULT_CONFIG.phMin;
      document.getElementById('cfg-ph-max').value = DEFAULT_CONFIG.phMax;
      document.getElementById('cfg-sim-interval').value = String(DEFAULT_CONFIG.simIntervalMs);
      document.getElementById('cfg-device-online').value = 'online';
      document.getElementById('cfg-sensor-error').value = 'none';
      SensorStore.current.ultrasonicDistanceCm = +(DEFAULT_CONFIG.tankRefHeightCm * (1 - SensorStore.current.waterLevelRaw / 100)).toFixed(1);
      if (SensorStore.simulationRunning) SimulationEngine.start();
      App.refreshAll();
    });
  }

  // Date & Time Formatting Helpers
  function formatTimeShort(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatHistoryLabel(date, range) {
    const d = date instanceof Date ? date : new Date(date);
    if (range === '1h' || range === '24h') {
      return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
  }

  function startClock() {
    const el = document.getElementById('topbar-datetime');
    const update = () => {
      const now = new Date();
      el.textContent = now.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }) + ' · ' + now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    update();
    setInterval(update, 1000);
  }

  // Bootstrap Application
  document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) {
      window.lucide.createIcons();
    }
    startClock();
    setupNavigation();
    setupDrawers();
    setupSimulationControls();
    setupHistoryAndNotifications();
    setupSettings();
    ChartManager.initAll();
    SimulationEngine.init();
    UIRenderer.syncSlidersFromState();
    App.refreshAll();
  });
})();

