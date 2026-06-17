// Data management and evaluation logic for REQ Wrangler
// Exposed globally via window.ReqData to allow running via file:// without CORS issues.

(function() {
  const STORAGE_KEY = 'req_wrangler_data';

  // Default mock data representing space flight instrument programs
  const defaultState = {
    testTypes: [
      'Environmental',
      'Integration',
      'Optical Calibration',
      'RF Calibration',
      'Software Integration',
      'Functional Verification',
      'SIL',
      'HIL',
      'Monte Carlo'
    ],
    componentCodes: [
      'SW',
      'ME',
      'EE',
      'OP',
      'SE'
    ],
    programs: [
      { id: 'PROG-SABER', name: 'SABER Sounding', description: 'Sounding of the Atmosphere using Broad-band Emission Radiometry instrument.' },
      { id: 'PROG-OPIR', name: 'OPIR Payload', description: 'Overhead Persistent Infrared sensor payload for space-based missile warning.' },
      { id: 'PROG-WISDOM', name: 'WISDOM Calibration', description: 'Wideband Imaging Spectrometry for Cosmic Observational Mapping calibration platform.' }
    ],
    capabilities: [
      { id: 'CAP-THERMAL', description: 'Maintain payload temperature thresholds below 80 Kelvin in vacuum.' },
      { id: 'CAP-COMMS', description: 'Transmit scientific payload data at rates exceeding 5 Mbps.' },
      { id: 'CAP-OPTICS', description: 'Attenuate out-of-field stray radiation to prevent sensor saturation.' },
      { id: 'CAP-POWER', description: 'Generate, regulate and distribute electrical power between payload subsystems.' },
      { id: 'CAP-DATALOGGER', description: 'Log and store high-resolution sensor readings in local flash memory.' },
      { id: 'CAP-STRUCTURE', description: 'Withstand structural launch vibration loads up to 15 G-rms.' }
    ],
    requirements: [
      // SABER Requirements
      { id: 'REQ-SAB-01', programId: 'PROG-SABER', capabilityId: 'CAP-THERMAL', inheritPassFromCapability: false, description: 'SABER focal plane assembly shall maintain temperatures below 75K via mechanical cryocooler.', component: 'ME', notes: 'High priority requirement. Critical for mission thermal budget.' },
      { id: 'REQ-SAB-02', programId: 'PROG-SABER', capabilityId: 'CAP-COMMS', inheritPassFromCapability: true, description: 'SABER downlink system shall transmit atmospheric profiles daily at 10 Mbps.', component: 'SW', notes: '' },
      { id: 'REQ-SAB-03', programId: 'PROG-SABER', capabilityId: 'CAP-OPTICS', inheritPassFromCapability: false, description: 'SABER primary telescope assembly shall utilize black anodized baffles to mitigate scatter.', component: 'OP', notes: '' },
      { id: 'REQ-SAB-04', programId: 'PROG-SABER', capabilityId: 'CAP-POWER', inheritPassFromCapability: false, description: 'SABER solar array deployment system shall trigger within 180 seconds of orbit insertion.', component: 'EE' },
      { id: 'REQ-SAB-05', programId: 'PROG-SABER', capabilityId: 'CAP-DATALOGGER', inheritPassFromCapability: false, description: 'SABER onboard flash memory shall retain up to 72 hours of telemetry logs in lossless compression.', component: 'SW' },
      { id: 'REQ-SAB-06', programId: 'PROG-SABER', capabilityId: 'CAP-STRUCTURE', inheritPassFromCapability: false, description: 'SABER primary housing shall maintain structural integrity at 12G static acceleration load.', component: 'ME' },
      { id: 'REQ-SAB-07', programId: 'PROG-SABER', capabilityId: null, inheritPassFromCapability: false, description: 'SABER flight firmware shall support remote firmware updates over secure uplink.', component: 'SW' },
      { id: 'REQ-SAB-08', programId: 'PROG-SABER', capabilityId: 'CAP-THERMAL', inheritPassFromCapability: false, description: 'SABER radiator shield shall reject stray solar radiation in high inclination orbits.', component: 'ME' },
      
      // OPIR Requirements
      { id: 'REQ-OPIR-01', programId: 'PROG-OPIR', capabilityId: 'CAP-THERMAL', inheritPassFromCapability: true, description: 'OPIR sensor core must achieve cryogenic stabilization within 48 hours of launch.', component: 'EE' },
      { id: 'REQ-OPIR-02', programId: 'PROG-OPIR', capabilityId: 'CAP-COMMS', inheritPassFromCapability: false, description: 'OPIR communications link must maintain continuous telemetry downlink at 12 Mbps.', component: 'SW' },
      { id: 'REQ-OPIR-03', programId: 'PROG-OPIR', capabilityId: null, inheritPassFromCapability: false, description: 'OPIR radiation hardening must withstand geostationary orbit radiation levels for 5 years.', component: 'EE' },
      { id: 'REQ-OPIR-04', programId: 'PROG-OPIR', capabilityId: 'CAP-POWER', inheritPassFromCapability: false, description: 'OPIR power conditioning unit shall supply stable 28V DC power to infrared focal planes.', component: 'EE' },
      { id: 'REQ-OPIR-05', programId: 'PROG-OPIR', capabilityId: 'CAP-DATALOGGER', inheritPassFromCapability: false, description: 'OPIR payload controller shall record calibration frame buffers at 60 Hz.', component: 'SW' },
      { id: 'REQ-OPIR-06', programId: 'PROG-OPIR', capabilityId: 'CAP-STRUCTURE', inheritPassFromCapability: false, description: 'OPIR optical bench alignment must remain within 5 micro-radians after vibration testing.', component: 'OP' },
      { id: 'REQ-OPIR-07', programId: 'PROG-OPIR', capabilityId: 'CAP-THERMAL', inheritPassFromCapability: false, description: 'OPIR cryogenic cooler control loop must maintain temperature stability within 0.05K.', component: 'SW' },

      // WISDOM Requirements
      { id: 'REQ-WIS-01', programId: 'PROG-WISDOM', capabilityId: 'CAP-OPTICS', inheritPassFromCapability: false, description: 'WISDOM calibration source baffle must reduce out-of-field stray light by a factor of 1e5.', component: 'OP' },
      { id: 'REQ-WIS-02', programId: 'PROG-WISDOM', capabilityId: 'CAP-COMMS', inheritPassFromCapability: true, description: 'WISDOM ground station interface shall support high-speed raw image dump.', component: 'SW' },
      { id: 'REQ-WIS-03', programId: 'PROG-WISDOM', capabilityId: 'CAP-POWER', inheritPassFromCapability: false, description: 'WISDOM peak power consumption shall not exceed 120 Watts during full calibration scan.', component: 'EE' },
      { id: 'REQ-WIS-04', programId: 'PROG-WISDOM', capabilityId: 'CAP-DATALOGGER', inheritPassFromCapability: false, description: 'WISDOM sensor subsystem must write raw image telemetry directly to local storage at 80 Mbps.', component: 'SW' },
      { id: 'REQ-WIS-05', programId: 'PROG-WISDOM', capabilityId: 'CAP-STRUCTURE', inheritPassFromCapability: false, description: 'WISDOM calibration wheel assembly shall support 100,000 rotation cycles in vacuum.', component: 'ME' },
      { id: 'REQ-WIS-06', programId: 'PROG-WISDOM', capabilityId: 'CAP-OPTICS', inheritPassFromCapability: false, description: 'WISDOM spectral filters shall cover wavelengths from 400 nm to 1100 nm.', component: 'OP' }
    ],
    tests: [
      // Tests linking to SABER requirements
      { id: 'TEST-SAB-01', name: 'SABER Cryocooler TVAC Run', type: 'Environmental', programDescription: 'Verify cryocooler thermal performance under space simulation vacuum.', location: 'https://github.com/aero-space/saber/blob/main/tests/cryo_tvac.py', status: 'Passed', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-01'], assigneeId: 'TM-1', notes: 'Requires coordination with vacuum chamber operators.', estimate: 3, passedDate: '2026-06-10T14:30:00.000Z' },
      { id: 'TEST-SAB-02', name: 'SABER Downlink Speed Test', type: 'SIL', programDescription: 'Measure telemetry packet transfer rate to simulated ground station.', location: 'https://github.com/aero-space/saber/blob/main/tests/downlink_rate.py', status: 'In Progress', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-02'], assigneeId: 'TM-2', notes: '', subtasks: { 'Simulink Test': 'Passing', 'SIL Test': 'In Progress' }, estimate: 1.5 },
      { id: 'TEST-SAB-03', name: 'SABER Baffle Scatter Scan', type: 'Optical Calibration', programDescription: 'Laser sweep of baffle inner walls to measure reflectance.', location: 'https://github.com/aero-space/saber/blob/main/tests/baffle_scatter.py', status: 'Passed', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-03'], assigneeId: 'TM-3', notes: '', estimate: 0.5, passedDate: '2026-06-11T09:15:00.000Z' },
      { id: 'TEST-SAB-04', name: 'SABER Solar Array Actuator Test', type: 'Functional Verification', programDescription: 'Verify deployment mechanism under low temp test.', location: 'https://github.com/aero-space/saber/blob/main/tests/solar_deploy.py', status: 'Not Started', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-04'], assigneeId: 'TM-3', notes: '', estimate: 1 },
      { id: 'TEST-SAB-05', name: 'SABER Flash Compression Bench Run', type: 'Software Integration', programDescription: 'Test sector write speeds and corruption recovery on flash drive.', location: 'https://github.com/aero-space/saber/blob/main/tests/flash_compress.py', status: 'Passed', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-05'], assigneeId: 'TM-2', notes: '', estimate: 2, passedDate: '2026-06-13T10:00:00.000Z' },
      { id: 'TEST-SAB-06', name: 'SABER Structural Vibration Scan', type: 'Environmental', programDescription: '3-axis shaker table run at qualification levels.', location: 'https://github.com/aero-space/saber/blob/main/tests/vib_scan.py', status: 'Not Started', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-06'], assigneeId: 'TM-4', notes: '', estimate: 3 },
      { id: 'TEST-SAB-07', name: 'SABER Secure OTA Firmware Test', type: 'Software Integration', programDescription: 'Check signature validation and fallback boot image.', location: 'https://github.com/aero-space/saber/blob/main/tests/secure_ota.py', status: 'In Progress', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-07'], assigneeId: 'TM-2', notes: '', estimate: 1.5 },
      { id: 'TEST-SAB-08', name: 'SABER Radiator Stray Heat Chamber Test', type: 'Environmental', programDescription: 'Stray light shield thermal testing.', location: 'https://github.com/aero-space/saber/blob/main/tests/radiator_shield.py', status: 'Passed', programId: 'PROG-SABER', requirementIds: ['REQ-SAB-08', 'REQ-SAB-01'], assigneeId: 'TM-1', notes: '', estimate: 2.5, passedDate: '2026-06-14T15:00:00.000Z' },

      // Tests linking to OPIR requirements
      { id: 'TEST-OPIR-01', name: 'OPIR Cooling Profile Test', type: 'Environmental', programDescription: 'Cool down curve verification from 290K to 70K.', location: 'https://github.com/aero-space/opir/blob/main/integration/cooling_profile.py', status: 'Not Started', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-01'], assigneeId: 'TM-4', notes: '', estimate: 2 },
      { id: 'TEST-OPIR-02', name: 'OPIR High-Rate Radio Test', type: 'RF Calibration', programDescription: 'RF transponder output power and bit error rate measurement.', location: 'https://github.com/aero-space/opir/blob/main/integration/high_rate_radio.py', status: 'Passed', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-02'], assigneeId: 'TM-5', notes: '', estimate: 1, passedDate: '2026-06-12T16:45:00.000Z' },
      { id: 'TEST-OPIR-03', name: 'OPIR Gamma Ray Exposure', type: 'Environmental', programDescription: 'Cobalt-60 source exposure to sensor control board.', location: 'https://github.com/aero-space/opir/blob/main/radiation/gamma_exposure.py', status: 'Passed', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-03'], assigneeId: null, notes: '', estimate: 4, passedDate: '2026-06-08T11:00:00.000Z' },
      { id: 'TEST-OPIR-04', name: 'OPIR PCU Regulation Test', type: 'Functional Verification', programDescription: 'Load transient and ripple measurement on 28V line.', location: 'https://github.com/aero-space/opir/blob/main/tests/pcu_regulation.py', status: 'Passed', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-04'], assigneeId: 'TM-5', notes: '', estimate: 1, passedDate: '2026-06-14T09:00:00.000Z' },
      { id: 'TEST-OPIR-05', name: 'OPIR High Frame Rate Buffer Check', type: 'Software Integration', programDescription: 'Check DMA transfer rates and ring buffer overrun safety.', location: 'https://github.com/aero-space/opir/blob/main/tests/buffer_check.py', status: 'In Progress', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-05'], assigneeId: 'TM-2', notes: '', estimate: 2 },
      { id: 'TEST-OPIR-06', name: 'OPIR Optical Alignment Sine-Sweep', type: 'Environmental', programDescription: 'Pre/post vibe optical alignment sanity checks.', location: 'https://github.com/aero-space/opir/blob/main/tests/opt_alignment.py', status: 'Not Started', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-06'], assigneeId: 'TM-3', notes: '', estimate: 4 },
      { id: 'TEST-OPIR-07', name: 'OPIR Cryo Control Loop SIL Run', type: 'SIL', programDescription: 'Simulated PID loop tuning for cold plate control.', location: 'https://github.com/aero-space/opir/blob/main/tests/cryo_loop_sil.py', status: 'Passed', programId: 'PROG-OPIR', requirementIds: ['REQ-OPIR-07', 'REQ-OPIR-01'], assigneeId: 'TM-4', notes: '', estimate: 1.5, passedDate: '2026-06-15T16:00:00.000Z' },

      // Tests linking to WISDOM requirements
      { id: 'TEST-WIS-01', name: 'WISDOM Optical Baffle Scatter Scan', type: 'Optical Calibration', programDescription: 'Stray light mitigation and goniometer scanning.', location: 'https://github.com/aero-space/wisdom/blob/main/optics/baffle_scatter.py', status: 'Passed', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-01'], assigneeId: 'TM-1', notes: '', estimate: 1, passedDate: '2026-06-11T13:20:00.000Z' },
      { id: 'TEST-WIS-02', name: 'WISDOM Ethernet Downlink Test', type: 'HIL', programDescription: 'Raw data dump transfer rate testing.', location: 'https://github.com/aero-space/wisdom/blob/main/comms/ethernet_speed.py', status: 'Not Started', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-02'], assigneeId: 'TM-2', notes: '', subtasks: { 'Simulink Test': 'Not Started', 'HIL Test': 'Not Started' }, estimate: 2 },
      { id: 'TEST-WIS-03', name: 'WISDOM Thermal Power Sweep', type: 'Functional Verification', programDescription: 'Measure power profile across target temperature profiles.', location: 'https://github.com/aero-space/wisdom/blob/main/tests/power_sweep.py', status: 'Passed', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-03'], assigneeId: 'TM-5', notes: '', estimate: 1, passedDate: '2026-06-12T10:00:00.000Z' },
      { id: 'TEST-WIS-04', name: 'WISDOM Telemetry Write Speed Test', type: 'Software Integration', programDescription: 'Measure write latency on internal storage media.', location: 'https://github.com/aero-space/wisdom/blob/main/tests/write_speed.py', status: 'In Progress', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-04'], assigneeId: 'TM-2', notes: '', estimate: 2 },
      { id: 'TEST-WIS-05', name: 'WISDOM Calibration Wheel Lifecycle Run', type: 'Environmental', programDescription: 'Continuous vacuum cycling of indexer motor.', location: 'https://github.com/aero-space/wisdom/blob/main/tests/wheel_lifecycle.py', status: 'Not Started', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-05'], assigneeId: 'TM-3', notes: '', estimate: 5 },
      { id: 'TEST-WIS-06', name: 'WISDOM Monochromator Filter Calibration', type: 'Optical Calibration', programDescription: 'Verify spectral throughput bands using monochromator.', location: 'https://github.com/aero-space/wisdom/blob/main/tests/filter_cal.py', status: 'Passed', programId: 'PROG-WISDOM', requirementIds: ['REQ-WIS-06', 'REQ-WIS-01'], assigneeId: 'TM-1', notes: '', estimate: 2, passedDate: '2026-06-13T11:00:00.000Z' }
    ],
    teamMembers: [
      { id: 'TM-1', name: 'Katherine Johnson', initials: 'KJ', color: '#0D9488' },
      { id: 'TM-2', name: 'Grace Hopper', initials: 'GH', color: '#4F46E5' },
      { id: 'TM-3', name: 'Alyx Vance', initials: 'AV', color: '#7C3AED' },
      { id: 'TM-4', name: 'Mae Jemison', initials: 'MJ', color: '#EA580C' },
      { id: 'TM-5', name: 'Wernher von Braun', initials: 'WV', color: '#059669' }
    ]
  };

  // Rollup statuses for subtasks
  function rollupStatus(subtaskStatuses) {
    const active = subtaskStatuses.filter(s => s !== 'N/A');
    if (active.length === 0) return 'Passed';
    
    const allPassing = active.every(s => s === 'Passing');
    if (allPassing) return 'Passed';
    
    const allNotStarted = active.every(s => s === 'Not Started');
    if (allNotStarted) return 'Not Started';
    
    return 'In Progress';
  }

  // Calculate test status from subtasks if applicable
  function calculateTestStatus(t) {
    if (t.type === 'SIL') {
      const sub = t.subtasks || {};
      const t1 = sub['Simulink Test'] || 'Not Started';
      const t2 = sub['SIL Test'] || 'Not Started';
      return rollupStatus([t1, t2]);
    } else if (t.type === 'HIL') {
      const sub = t.subtasks || {};
      const t1 = sub['Simulink Test'] || 'Not Started';
      const t2 = sub['HIL Test'] || 'Not Started';
      return rollupStatus([t1, t2]);
    } else if (t.type === 'Monte Carlo') {
      const sub = t.subtasks || {};
      const t1 = sub['MC Test'] || 'Not Started';
      return rollupStatus([t1]);
    }
    return t.status || 'Not Started';
  }

  // Evaluation engine
  function evaluate(state) {
    const { requirements, capabilities, tests } = state;

    // Roll up subtask statuses to overall test status
    tests.forEach(t => {
      t.status = calculateTestStatus(t);
      if (t.status === 'Passed') {
        if (!t.passedDate) {
          t.passedDate = new Date().toISOString();
        }
      } else {
        t.passedDate = null;
      }
    });

    // Reset status tracking
    requirements.forEach(req => {
      req.status = 'Not Started';
      req.statusReason = 'No test linked';
      req.baseStatus = 'Not Started';
      req.baseStatusReason = 'No test linked';
    });

    capabilities.forEach(cap => {
      cap.status = 'Not Started';
      cap.passingRequirementIds = []; // Track which requirement(s) passed it
    });

    // Step 1: Evaluate requirements that do NOT inherit status from capabilities
    requirements.forEach(req => {
      // Find all tests in the same program that pass off this requirement
      const linkedTests = tests.filter(t => 
        t.programId === req.programId && 
        t.requirementIds && 
        t.requirementIds.includes(req.id)
      );

      // Calculate base status (status purely from tests)
      if (linkedTests.length > 0) {
        const statuses = linkedTests.map(t => t.status);
        if (statuses.includes('Passed')) {
          req.baseStatus = 'Passed';
          const passedNames = linkedTests.filter(t => t.status === 'Passed').map(t => t.name);
          req.baseStatusReason = `Passed by verification test(s): ${passedNames.join(', ')}`;
        } else if (statuses.includes('In Progress')) {
          req.baseStatus = 'In Progress';
          const ipNames = linkedTests.filter(t => t.status === 'In Progress').map(t => t.name);
          req.baseStatusReason = `In progress via test(s): ${ipNames.join(', ')}`;
        } else {
          req.baseStatus = 'Not Started';
          const nsNames = linkedTests.filter(t => t.status === 'Not Started').map(t => t.name);
          req.baseStatusReason = `Not started via test(s): ${nsNames.join(', ')}`;
        }
      } else {
        req.baseStatus = 'Not Started';
        req.baseStatusReason = 'No verification tests are linked to this requirement';
      }

      // If it doesn't inherit, its final status is its base status
      if (!req.inheritPassFromCapability) {
        req.status = req.baseStatus;
        req.statusReason = req.baseStatusReason;
      }
    });

    // Step 2: Evaluate capabilities
    // A capability passes if at least one linked requirement is passed by its own test (baseStatus === 'Passed')
    capabilities.forEach(cap => {
      // Find requirements linked to this capability
      const linkedReqs = requirements.filter(req => req.capabilityId === cap.id);
      
      // Filter those that are passed by their own tests (to avoid circular dependency)
      const passingReqsList = linkedReqs.filter(req => req.baseStatus === 'Passed');

      // Determine overall status
      if (passingReqsList.length > 0) {
        cap.status = 'Passed';
        cap.passingRequirementIds = passingReqsList.map(r => r.id);
      } else {
        // Check if any requirements are in progress
        const anyInProgress = linkedReqs.some(req => req.baseStatus === 'In Progress');
        cap.status = anyInProgress ? 'In Progress' : 'Not Started';
        cap.passingRequirementIds = [];
      }
    });

    // Step 3: Evaluate requirements that DO inherit status from capabilities
    requirements.forEach(req => {
      if (req.inheritPassFromCapability) {
        if (req.capabilityId) {
          const linkedCap = capabilities.find(c => c.id === req.capabilityId);
          
          if (linkedCap && linkedCap.status === 'Passed') {
            req.status = 'Passed';
            req.statusReason = `Inherited pass from Capability "${linkedCap.id}" (passed by ${linkedCap.passingRequirementIds.join(', ')})`;
          } else {
            // If the capability is NOT passed, the requirement falls back to its own test status
            req.status = req.baseStatus;
            req.statusReason = req.baseStatusReason ? `${req.baseStatusReason} (Capability is not Passed)` : 'No test linked, and capability is not Passed';
          }
        } else {
          // No linked capability, fall back to base status
          req.status = req.baseStatus;
          req.statusReason = `${req.baseStatusReason} (No capability linked)`;
        }
      }
    });

    return state;
  }

  // Load state from localStorage or use default mock data
  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state = JSON.parse(stored);
        // Ensure properties exist
        if (state.programs && state.requirements && state.capabilities && state.tests) {
          // Ensure testTypes exists in older saves
          if (!state.testTypes) {
            state.testTypes = JSON.parse(JSON.stringify(defaultState.testTypes));
          }

          // Ensure default subtask types are present
          if (!state.testTypes.includes('SIL')) state.testTypes.push('SIL');
          if (!state.testTypes.includes('HIL')) state.testTypes.push('HIL');
          if (!state.testTypes.includes('Monte Carlo')) state.testTypes.push('Monte Carlo');

          // Ensure componentCodes exists in older saves
          if (!state.componentCodes) {
            state.componentCodes = JSON.parse(JSON.stringify(defaultState.componentCodes));
          }

          // Ensure teamMembers exists in older saves
          if (!state.teamMembers) {
            state.teamMembers = JSON.parse(JSON.stringify(defaultState.teamMembers));
          }

          // Remove capability names if they still exist from older versions
          state.capabilities.forEach(c => {
            if (c.hasOwnProperty('name')) {
              delete c.name;
            }
          });
          
          // Migrate/Normalize legacy test structures
          state.tests.forEach(t => {
            // Ensure test has assigneeId property
            if (!t.hasOwnProperty('assigneeId')) {
              if (t.id === 'TEST-SAB-01') t.assigneeId = 'TM-1';
              else if (t.id === 'TEST-SAB-02') t.assigneeId = 'TM-2';
              else if (t.id === 'TEST-SAB-03') t.assigneeId = 'TM-3';
              else if (t.id === 'TEST-OPIR-01') t.assigneeId = 'TM-4';
              else if (t.id === 'TEST-OPIR-02') t.assigneeId = 'TM-5';
              else if (t.id === 'TEST-WIS-01') t.assigneeId = 'TM-1';
              else if (t.id === 'TEST-WIS-02') t.assigneeId = 'TM-2';
              else t.assigneeId = null;
            }

            // Ensure notes exists
            if (!t.hasOwnProperty('notes')) t.notes = '';

            // Ensure estimate exists and is a valid number
            if (!t.hasOwnProperty('estimate') || t.estimate === undefined || t.estimate === null) {
              t.estimate = 0;
            } else {
              t.estimate = parseFloat(t.estimate) || 0;
            }

            // Ensure subtasks exist for SIL, HIL, Monte Carlo
            if (t.type === 'SIL' && !t.subtasks) {
              t.subtasks = { 'Simulink Test': 'Not Started', 'SIL Test': 'Not Started' };
            } else if (t.type === 'HIL' && !t.subtasks) {
              t.subtasks = { 'Simulink Test': 'Not Started', 'HIL Test': 'Not Started' };
            } else if (t.type === 'Monte Carlo' && !t.subtasks) {
              t.subtasks = { 'MC Test': 'Not Started' };
            }
            // Normalize status
            if (t.status === 'PASSED') t.status = 'Passed';
            else if (t.status === 'PENDING') t.status = 'In Progress';
            else if (t.status === 'FAILED') t.status = 'Not Started';

            // Migrate requirementId (string) to requirementIds (array of strings)
            if (t.hasOwnProperty('requirementId') && !t.hasOwnProperty('requirementIds')) {
              t.requirementIds = t.requirementId ? [t.requirementId] : [];
              delete t.requirementId;
            }

            // Ensure test has a programId
            if (!t.programId) {
              if (t.requirementIds && t.requirementIds.length > 0) {
                const matchingReq = state.requirements.find(r => r.id === t.requirementIds[0]);
                t.programId = matchingReq ? matchingReq.programId : (state.programs[0] ? state.programs[0].id : '');
              } else {
                t.programId = state.programs[0] ? state.programs[0].id : '';
              }
            }
          });
          
          state.requirements.forEach(r => {
            if (r.status === 'PASSED') r.status = 'Passed';
            else if (r.status === 'PENDING') r.status = 'In Progress';
            else if (r.status === 'FAILED') r.status = 'Not Started';

            // Ensure notes exists
            if (!r.hasOwnProperty('notes')) r.notes = '';

            // Ensure requirement has a component code
            if (!r.component) {
              if (r.id.includes('SW') || r.description.toLowerCase().includes('software') || r.description.toLowerCase().includes('downlink') || r.description.toLowerCase().includes('data')) {
                r.component = 'SW';
              } else if (r.description.toLowerCase().includes('optical') || r.description.toLowerCase().includes('baffle') || r.description.toLowerCase().includes('light')) {
                r.component = 'OP';
              } else if (r.description.toLowerCase().includes('thermal') || r.description.toLowerCase().includes('temperature') || r.description.toLowerCase().includes('mechanical') || r.description.toLowerCase().includes('cryo')) {
                r.component = 'ME';
              } else {
                r.component = 'SE';
              }
            }
          });

          return evaluate(state);
        }
      }
    } catch (e) {
      console.error("Failed to load state from localStorage:", e);
    }
    // Fallback to default
    return evaluate(JSON.parse(JSON.stringify(defaultState)));
  }

  // Save state to localStorage
  function saveState(state) {
    try {
      const evaluatedState = evaluate(state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(evaluatedState));
      return evaluatedState;
    } catch (e) {
      console.error("Failed to save state to localStorage:", e);
      return state;
    }
  }

  // Reset state to mock data
  function resetState() {
    const freshState = JSON.parse(JSON.stringify(defaultState));
    return saveState(freshState);
  }

  // Export functions to global scope
  window.ReqData = {
    loadState,
    saveState,
    resetState,
    evaluate,
    defaultState,
    calculateTestStatus,
    rollupStatus
  };
})();
