// ---------- state ----------
let files = []; // {id,name, headers, rows, tag, sessionLabel, hasPowerChannels, usePower, qc, N}
let dashFiles = []; // {id,name,headers,rows,N,summary} — logs de dashboard, usados só para enriquecer com altitude/rampa
let aggregated = null; // last processing result (WOT)
let aggregatedMid = null; // last processing result (carga média / parcial)
let fileIdSeq = 0;
let tagOrder = []; // ordem de exibição dos mapas nos gráficos/tabelas/legendas, controlada pelo usuário

// Paleta rotativa para clusters/mapas descobertos dinamicamente a partir do nome do arquivo.
// "base"/"vvt" sempre fica ciano (referência); os demais (soma_NN, tira_NN, ou qualquer
// rótulo novo que apareça no nome do arquivo) recebem cor da paleta na ordem em que aparecem,
// sem precisar tocar no código para novos testes (soma_60, tira_10, etc.).
function classify(filename){
  const f = filename.toLowerCase();
  // captura qualquer padrão "soma_NN" / "tira_NN" / "calib_NN" (com ou sem underscore/hífen), presente e futuro
  const m = f.match(/(soma|tira|calib)[_-]?(\d+)/);
  if(m) return m[1]+'_'+m[2];
  if(/(^|[^a-z])calib([^a-z]|$)/.test(f)) return 'calib';
  if(/vvt|_base_|(^|[^a-z])base([^a-z]|$)/.test(f)) return 'base';
  return 'custom';
}

// Extrai a data a partir da convenção de nome de arquivo "LOG_AAAA_MM_DD..." (prefixo LOG_
// seguido de 4 dígitos de ano). Evita o bug de capturar os 2 últimos dígitos do ano como se
// fossem o dia. Exibe no padrão brasileiro dd/mm. Também cobre a convenção nova sem prefixo
// LOG/ano, ex.: "08_18_base_".
function sessionLabel(filename){
  let s = filename.replace(/\.[^.]+$/,'');
  const withYear = s.match(/^LOG_\d{4}_(\d{2})_(\d{2})/i);
  const withoutYear = s.match(/^(\d{2})_(\d{2})/);
  const m = withYear || withoutYear;
  if(!m) return '—';
  const month = m[1], day = m[2];
  const rest = s.slice(m[0].length);
  const suf = rest.match(/^([a-z])(?:_|$)/i);
  return day+'/'+month+(suf?('_'+suf[1]):'');
}

// Chave numérica para ordenar a lista de arquivos por data crescente (mês, dia, sufixo de sessão).
// Arquivos sem data reconhecível vão para o final da lista.
function dateSortKey(filename){
  let s = filename.replace(/\.[^.]+$/,'');
  const withYear = s.match(/^LOG_\d{4}_(\d{2})_(\d{2})/i);
  const withoutYear = s.match(/^(\d{2})_(\d{2})/);
  const m = withYear || withoutYear;
  if(!m) return Number.MAX_SAFE_INTEGER;
  const month = parseInt(m[1],10), day = parseInt(m[2],10);
  const rest = s.slice(m[0].length);
  const suf = rest.match(/^([a-z])(?:_|$)/i);
  const sufOrder = suf ? suf[1].toLowerCase().charCodeAt(0) : 0;
  return month*1000000 + day*10000 + sufOrder;
}

// Garante que um mapa recém-descoberto entre no fim da ordem de exibição, sem repetir.
function ensureTagInOrder(tag){
  if(!tagOrder.includes(tag)) tagOrder.push(tag);
}

// Recalcula a ordem "ativa" (só mapas presentes atualmente nos arquivos), preservando a ordem
// manual já definida e acrescentando ao final qualquer mapa novo que ainda não estava lá.
function currentTagsInOrder(){
  const present = new Set(files.map(f=>f.tag));
  const ordered = tagOrder.filter(t=>present.has(t));
  present.forEach(t=>{ if(!ordered.includes(t)) ordered.push(t); });
  tagOrder = ordered;
  return ordered;
}

// Aplica a ordem global de mapas a um objeto agregado (reordena agg.tags in-place),
// mantendo apenas os mapas que de fato têm dados nesse agregado.
function applyTagOrder(agg){
  if(!agg) return;
  const present = agg.tags;
  const ordered = tagOrder.filter(t=>present.includes(t));
  present.forEach(t=>{ if(!ordered.includes(t)) ordered.push(t); });
  agg.tags = ordered;
}

function isDashFile(headers){
  return headers.includes('GPS Altitude') && !headers.includes('Corrected VE');
}

// ---- Sincronização por tempo absoluto (GPS UTC Date/Time -> epoch), com detecção de corte
// de sessão (poder desligado/religado) onde o deslocamento entre Datalog Time e o epoch GPS
// muda de forma abrupta. Usado tanto para os logs de dashboard quanto para os de ECU, já que
// ambos têm os mesmos canais de data/hora GPS. ----
function buildAbsoluteTimeline(rows, idxDT, idxDate, idxTime, idxSats, minSats){
  const N = rows.length;
  const absTime = new Array(N).fill(NaN);
  let offset = null, sessionCount = 0;
  for(let i=0;i<N;i++){
    const dt = num(rows[i], idxDT);
    const sats = idxSats>=0 ? num(rows[i], idxSats) : Infinity;
    const rawEpoch = gpsToEpoch(num(rows[i],idxDate), num(rows[i],idxTime));
    if(!isNaN(rawEpoch) && (idxSats<0 || sats>=minSats)){
      const candidate = rawEpoch - dt;
      if(offset===null || Math.abs(candidate-offset) > 3){ offset = candidate; sessionCount++; }
      else offset = offset*0.98 + candidate*0.02;
    }
    if(offset!==null) absTime[i] = dt + offset;
  }
  return {absTime, sessionCount};
}

function detectPreCrankBaroKPa(rows, idxRpm, idxMap, idxDt){
  if(idxRpm<0 || idxMap<0) return NaN;
  let end = 0;
  while(end<rows.length){
    const rpm = num(rows[end], idxRpm);
    if(isNaN(rpm) || rpm>0) break;
    end++;
  }
  if(end<3) return NaN; // trecho curto demais pra confiar
  let start = 0;
  if(idxDt>=0){
    const tEnd = num(rows[end-1], idxDt);
    start = end-1;
    while(start>0 && (tEnd - num(rows[start-1], idxDt)) <= 3) start--;
  } else {
    start = Math.max(0, end-60);
  }
  const vals = [];
  for(let i=start;i<end;i++){ const v=num(rows[i], idxMap); if(!isNaN(v)) vals.push(v); }
  if(vals.length<3) return NaN;
  vals.sort((a,b)=>a-b);
  return vals[Math.floor(vals.length/2)];
}

// Pressão de saturação de vapor d'água (Magnus-Tetens), retorna kPa a partir de T em °C.
const DASH_MIN_SATS = 4;
const DASH_SMOOTH_WINDOW = 25; // pontos, ~0.5s a 50Hz
const DASH_MAX_GAP_S = 5;      // além disso, considera sem cobertura

// Canais que ainda não existem populados na rede CAN do carro (sensores em instalação:
// rotação no câmbio para Vehicle Speed, MAF, pressão de óleo/combustível). A ferramenta já
// reconhece a coluna se ela existir no arquivo e reporta se tem dado real ou está zerada —
// não usa nada disso em nenhum cálculo ainda. Quando a rede CAN for populada de verdade,
// esses canais passam a aparecer como "disponível" aqui sem precisar mexer no código.
const FUTURE_CHANNELS = [
  {key:'vehicleSpeed', col:'Vehicle Speed', label:'Vehicle Speed (roda)'},
  {key:'gearPosition', col:'Gear Position', label:'Gear Position (sensor)'},
  {key:'maf', col:'MAF Air Flow Rate', label:'MAF Air Flow Rate'},
  {key:'fuelPressEcu', col:'Fuel Pressure ECU', label:'Fuel Pressure ECU'},
  {key:'fuelPressTdl', col:'Fuel Pressure TDL', label:'Fuel Pressure TDL'},
  {key:'oilTemp', col:'Engine Oil Temperature', label:'Engine Oil Temperature'},
];

function checkFutureChannels(rec){
  return FUTURE_CHANNELS.map(fc=>{
    const idx = rec.headers.indexOf(fc.col);
    if(idx<0) return {...fc, present:false, populated:false, n:0};
    let n=0;
    for(let i=0;i<rec.rows.length;i++){
      const v = num(rec.rows[i], idx);
      if(!isNaN(v) && v!==0){ n++; }
    }
    return {...fc, present:true, populated:n>0, n};
  });
}

function summarizeDashFile(rec){
  const idx = {
    dt: rec.headers.indexOf('Datalog Time'), date: rec.headers.indexOf('GPS UTC Date'),
    time: rec.headers.indexOf('GPS UTC Time'), sats: rec.headers.indexOf('GPS Sats Used'),
    alt: rec.headers.indexOf('GPS Altitude')
  };
  const {absTime, sessionCount} = buildAbsoluteTimeline(rec.rows, idx.dt, idx.date, idx.time, idx.sats, DASH_MIN_SATS);
  let validN=0, altMin=Infinity, altMax=-Infinity, firstT=null, lastT=null;
  for(let i=0;i<rec.rows.length;i++){
    if(isNaN(absTime[i])) continue;
    const sats = num(rec.rows[i], idx.sats), alt = num(rec.rows[i], idx.alt);
    if(sats>=DASH_MIN_SATS && alt!==0){
      validN++;
      if(alt<altMin) altMin=alt;
      if(alt>altMax) altMax=alt;
      if(firstT===null) firstT=absTime[i];
      lastT=absTime[i];
    }
  }
  return {
    sessionCount, validN,
    coveragePct: rec.rows.length ? (100*validN/rec.rows.length) : 0,
    altMin: isFinite(altMin)?altMin:NaN, altMax: isFinite(altMax)?altMax:NaN,
    firstT, lastT,
    futureChannels: checkFutureChannels(rec)
  };
}

function buildDashAltitudeTimeline(){
  if(!dashFiles.length) return null;
  let pts = [];
  dashFiles.forEach(rec=>{
    const idx = {
      dt: rec.headers.indexOf('Datalog Time'), date: rec.headers.indexOf('GPS UTC Date'),
      time: rec.headers.indexOf('GPS UTC Time'), sats: rec.headers.indexOf('GPS Sats Used'),
      alt: rec.headers.indexOf('GPS Altitude'), lat: rec.headers.indexOf('GPS Latitude'),
      lon: rec.headers.indexOf('GPS Longitude')
    };
    const {absTime} = buildAbsoluteTimeline(rec.rows, idx.dt, idx.date, idx.time, idx.sats, DASH_MIN_SATS);
    for(let i=0;i<rec.rows.length;i++){
      if(isNaN(absTime[i])) continue;
      const sats = num(rec.rows[i], idx.sats), alt = num(rec.rows[i], idx.alt);
      if(sats>=DASH_MIN_SATS && alt!==0){
        pts.push({t:absTime[i], alt, lat:num(rec.rows[i],idx.lat), lon:num(rec.rows[i],idx.lon)});
      }
    }
  });
  if(!pts.length) return null;
  pts.sort((a,b)=>a.t-b.t);
  const W = DASH_SMOOTH_WINDOW;
  const smoothed = pts.map((p,i)=>{
    const lo=Math.max(0,i-W), hi=Math.min(pts.length-1,i+W);
    let sum=0,c=0; for(let k=lo;k<=hi;k++){ sum+=pts[k].alt; c++; }
    return {t:p.t, alt:sum/c, lat:p.lat, lon:p.lon};
  });

  function altAt(t){
    let lo=0, hi=smoothed.length-1;
    if(t<smoothed[0].t || t>smoothed[hi].t) return null;
    while(hi-lo>1){ const mid=(lo+hi)>>1; if(smoothed[mid].t<t) lo=mid; else hi=mid; }
    const a=smoothed[lo], b=smoothed[hi];
    if(b.t-a.t>DASH_MAX_GAP_S) return null;
    const f=(t-a.t)/((b.t-a.t)||1);
    return { alt:a.alt+(b.alt-a.alt)*f, lat:a.lat+(b.lat-a.lat)*f, lon:a.lon+(b.lon-a.lon)*f };
  }
  function gradeAt(t, halfWindow, minDist, plausMax){
    halfWindow = halfWindow || 1.5;
    minDist = (minDist===undefined) ? 5 : minDist;
    plausMax = (plausMax===undefined) ? Infinity : plausMax;
    const p1=altAt(t-halfWindow), p2=altAt(t+halfWindow);
    if(!p1||!p2) return NaN;
    const dist = haversineMeters(p1.lat,p1.lon,p2.lat,p2.lon);
    if(dist<minDist) return NaN; // janela curta -> distância percorrida pequena -> ruído de altitude do GPS domina
    const grade = (p2.alt-p1.alt)/dist*100;
    if(Math.abs(grade)>plausMax) return NaN; // fora do plausível fisicamente -> provável glitch de GPS, não rampa real
    return grade;
  }
  return {altAt, gradeAt, coverageStart: smoothed[0].t, coverageEnd: smoothed[smoothed.length-1].t};
}

function runQC(headers, rows, idxAccel, idxGear, idxRpm){
  const flags = [];
  let severe=false;
  if(idxAccel<0 || idxGear<0){
    flags.push('sem canais de aceleração/marcha');
    return {flags, severe:false, note:'apenas escore composto (lambda/injeção) disponível'};
  }
  // sample flatline check + stuck gear check over a subsample for speed
  const step = Math.max(1, Math.floor(rows.length/4000));
  let accVals=[], gearAt1HighRpm=0, highRpmCount=0;
  for(let i=0;i<rows.length;i+=step){
    const a = parseFloat(rows[i][idxAccel]);
    if(!isNaN(a)) accVals.push(a);
    const rpm = parseFloat(rows[i][idxRpm]);
    const g = parseFloat(rows[i][idxGear]);
    if(!isNaN(rpm) && rpm>3000){
      highRpmCount++;
      if(g===1) gearAt1HighRpm++;
    }
  }
  if(accVals.length>5){
    const mean = accVals.reduce((a,b)=>a+b,0)/accVals.length;
    const variance = accVals.reduce((a,b)=>a+(b-mean)*(b-mean),0)/accVals.length;
    if(Math.sqrt(variance) < 0.02){ flags.push('aceleração parece achatada (baixa variância)'); severe=true; }
  }
  if(highRpmCount>10 && (gearAt1HighRpm/highRpmCount) > 0.8){
    flags.push('marcha travada em 1 com RPM alto'); severe=true;
  }
  return {flags, severe};
}

// Cobertura de altitude do GPS por arquivo de ECU, contra os logs de dashboard já carregados.
// Recalculada sempre que a lista de arquivos ou de dashboards muda. Varre linha a linha (não
// amostra) porque a coluna de check "100%" precisa ser exata, não aproximada.
function cleanupDeprecatedStorage(){
  let freedBytes = 0;
  const removedKeys = [];
  DEPRECATED_STORAGE_KEYS.forEach(key=>{
    try{
      const raw = localStorage.getItem(key);
      if(raw!==null){
        freedBytes += new Blob([raw]).size;
        localStorage.removeItem(key);
        removedKeys.push(key);
      }
    } catch(e){ /* localStorage indisponível/bloqueado — silencioso, nada a limpar mesmo */ }
  });
  return {removedKeys, freedBytes};
}

function loadSavedMapsList(){
  try{
    const raw = localStorage.getItem(MAPS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ return []; }
}
function writeSavedMapsList(list){
  try{ localStorage.setItem(MAPS_STORAGE_KEY, JSON.stringify(list)); return true; } catch(e){ return false; }
}
// ---------- filtros de linha compartilhados (usados por processFile E getEligibleCalibRows) ----------
// Extraídos pra não ter duas implementações divergindo com o tempo — antes, a calibração tinha
// uma cópia independente desses 4 filtros, sem o fallback de pedal que o processamento principal
// já tinha (log só com Pedal Position, sem canal de TP, ficava sem filtro nenhum na calibração).

function resolveLoadValue(rows, i, idxTp, idxPedal){
  const tp = num(rows[i], idxTp);
  const pedal = num(rows[i], idxPedal);
  return !isNaN(tp) ? tp : pedal;
}

function detectEtExclusion(rows, idxEt, params){
  const N = rows.length;
  const etVals = new Array(N);
  for(let i=0;i<N;i++) etVals[i] = num(rows[i], idxEt);
  const etBad = new Array(N).fill(false);
  for(let i=0;i<N;i++){
    const e = etVals[i];
    let bad=false;
    if(isNaN(e)) bad=true;
    else if(e<params.etMin || e>params.etMax) bad=true;
    else if(i>0 && !isNaN(etVals[i-1]) && Math.abs(e-etVals[i-1])>params.etMaxDelta) bad=true;
    etBad[i]=bad;
  }
  const etExcluded = etBad.slice();
  for(let i=0;i<N;i++){
    if(etBad[i]){
      const lo=Math.max(0,i-params.etWindow), hi=Math.min(N-1,i+params.etWindow);
      for(let k=lo;k<=hi;k++) etExcluded[k]=true;
    }
  }
  return etExcluded;
}

// Despique de GPS Speed: um "fix válido" às vezes volta um pouco antes de a solução de
// velocidade estabilizar de verdade após perda de sinal, gerando um salto de velocidade
// fisicamente impossível entre amostras consecutivas sem que GPS Fix Status acuse isso.
function detectGpsSpeedDespike(rows, idxGpsSpeed, params){
  const N = rows.length;
  const gpsSpeedExcluded = new Array(N).fill(false);
  if(idxGpsSpeed<0) return gpsSpeedExcluded;
  const gsVals = new Array(N);
  for(let i=0;i<N;i++) gsVals[i] = num(rows[i], idxGpsSpeed);
  const gsBad = new Array(N).fill(false);
  for(let i=1;i<N;i++){
    if(!isNaN(gsVals[i]) && !isNaN(gsVals[i-1]) && Math.abs(gsVals[i]-gsVals[i-1])>params.speedJumpMaxKmh){
      gsBad[i]=true; gsBad[i-1]=true;
    }
  }
  for(let i=0;i<N;i++){
    if(gsBad[i]){
      const lo=Math.max(0,i-params.speedJumpWindow), hi=Math.min(N-1,i+params.speedJumpWindow);
      for(let k=lo;k<=hi;k++) gpsSpeedExcluded[k]=true;
    }
  }
  return gpsSpeedExcluded;
}

// Despique de estabilidade de TP/Pedal: mede a amplitude (máx-mín) dentro de uma janela
// retroativa, não só o degrau anterior — pega tanto saltos abruptos quanto transições lentas
// de várias amostras (lift-e-retomada) que um filtro de degrau único não pegaria.
function detectTpTransientExclusion(rows, idxTp, idxPedal, params){
  const N = rows.length;
  const loadValsAll = new Array(N);
  for(let i=0;i<N;i++) loadValsAll[i] = resolveLoadValue(rows, i, idxTp, idxPedal);
  const tpExcluded = new Array(N).fill(false);
  const W = Math.max(1, params.tpJumpWindow);
  for(let i=0;i<N;i++){
    if(i < W-1){ tpExcluded[i]=true; continue; } // sem histórico suficiente ainda
    let lo=Infinity, hi=-Infinity, any=false;
    for(let k=i-W+1;k<=i;k++){
      const v = loadValsAll[k];
      if(!isNaN(v)){ any=true; if(v<lo) lo=v; if(v>hi) hi=v; }
    }
    if(any && (hi-lo) > params.tpMaxDelta) tpExcluded[i]=true;
  }
  return tpExcluded;
}

// v em m/s: prioriza GPS Speed direto; cai pro fallback via rpm/marcha/diferencial/pneu só
// quando o GPS está ausente/zero. Não aplica piso de velocidade mínima aqui — isso é filtro
// separado (params.speedMinKmh), responsabilidade de quem chama.
function resolveVelocityMs(rpm, gearN, gsKmh, params){
  let v = NaN;
  if(!isNaN(gsKmh) && gsKmh>0) v = gsKmh/3.6;
  if((isNaN(v)||v<=0) && gearN>=1 && gearN<=params.gearRatios.length){
    const gr = params.gearRatios[Math.round(gearN)-1];
    if(gr>0 && !isNaN(rpm)) v = (rpm/(gr*params.diffRatio))*(2*Math.PI*params.tireRadius)/60;
  }
  return v;
}

// ---------- per-file processing ----------
function processFile(rec, params, dashTimeline){
  const headers = rec.headers, rows = rec.rows;
  const idx = {
    accel: headers.indexOf('Acceleration'),
    gear: headers.indexOf('Analyzer Calculate Gear'),
    et: headers.indexOf('Engine Temperature ET'),
    cve: headers.indexOf('Corrected VE'),
    map: headers.indexOf('Manifold Absolute Pressure MAP'),
    lambda: headers.indexOf('Lambda 1 Value'),
    lambdaTarget: headers.indexOf('Lambda Target'),
    tp: headers.indexOf('Throttle Position TP TP1L'),
    pedal: headers.indexOf('Pedal 1 Position PP1'),
    gpsSpeed: headers.indexOf('GPS Speed'),
    gpsFix: headers.indexOf('GPS Fix Status'),
    gpsDate: headers.indexOf('GPS UTC Date'),
    gpsTime: headers.indexOf('GPS UTC Time'),
    gpsSats: headers.indexOf('GPS Sats Used'),
    rpm: headers.indexOf('Engine Speed'),
    inj: headers.indexOf('Fuel Injection Timing'),
    gft: headers.indexOf('Global Fuel Trim'),
    fct: headers.indexOf('Fuel Comp Total'),
    iat: headers.indexOf('Intake Air Temperature IAT'),
    dt: headers.indexOf('Datalog Time'),
  };
  const N = rows.length;

  // Timeline absoluta deste próprio arquivo de ECU, só construída se houver um timeline de
  // dashboard carregado para casar contra (evita custo à toa quando não há enriquecimento).
  let ecuAbsTime = null;
  if(dashTimeline && idx.gpsDate>=0 && idx.gpsTime>=0){
    ecuAbsTime = buildAbsoluteTimeline(rows, idx.dt, idx.gpsDate, idx.gpsTime, idx.gpsSats, DASH_MIN_SATS).absTime;
  }

  // Densidade do ar por amostra: pressão em 3 níveis de prioridade —
  //  1) altitude do GPS (dashboard), quando disponível e habilitado — mais granular, varia
  //     amostra a amostra com o terreno percorrido;
  //  2) pressão barométrica medida no pré-partida deste próprio arquivo (RPM=0), quando
  //     detectável — constante para o arquivo inteiro, mas é pressão REAL medida naquele dia,
  //     não uma altitude assumida;
  //  3) altitude fixa do projeto (fallback genérico), via fórmula barométrica padrão.
  // + temperatura do piso de IAT numa janela móvel (evita ler calor retido no cofre do motor
  // como se fosse ambiente). Sem canal de IAT, cai no ρ fixo de fallback da seção 02.
  const preCrankBaroKPa = detectPreCrankBaroKPa(rows, idx.rpm, idx.map, idx.dt);
  let rhoSample = null;
  if(idx.iat>=0 && idx.dt>=0){
    const dtVals = new Array(N), iatVals = new Array(N);
    for(let i=0;i<N;i++){ dtVals[i] = num(rows[i], idx.dt); iatVals[i] = num(rows[i], idx.iat); }
    const iatFloor = rollingMinByTime(dtVals, iatVals, params.iatWindowMin*60);
    rhoSample = new Array(N);
    for(let i=0;i<N;i++){
      let P_kPa;
      if(params.useGpsAltitude && dashTimeline && ecuAbsTime && !isNaN(ecuAbsTime[i]) && dashTimeline.altAt(ecuAbsTime[i])){
        P_kPa = pressureFromAltitude(dashTimeline.altAt(ecuAbsTime[i]).alt)/1000;
      } else if(!isNaN(preCrankBaroKPa)){
        P_kPa = preCrankBaroKPa;
      } else {
        P_kPa = pressureFromAltitude(params.avgAltitude)/1000;
      }
      const tC = iatFloor[i];
      rhoSample[i] = !isNaN(tC) ? airDensityDry(P_kPa, tC) : params.rho;
    }
  }

  const etExcluded = detectEtExclusion(rows, idx.et, params);
  const gpsSpeedExcluded = detectGpsSpeedDespike(rows, idx.gpsSpeed, params);
  const tpExcluded = detectTpTransientExclusion(rows, idx.tp, idx.pedal, params);

  const out = [];
  const outLoad = [];
  let wotCount=0, etExcludedCount=0, loadCount=0;
  const gAll = 9.80665;

  function computeSample(i, rpm, tp, pedal){
    const cve = num(rows[i], idx.cve);
    const mapv = num(rows[i], idx.map);
    const lambda = num(rows[i], idx.lambda);
    const lambdaTarget = (params.lambdaSrc==='log' && idx.lambdaTarget>=0)
      ? num(rows[i], idx.lambdaTarget) : params.lambdaTarget;
    const inj = num(rows[i], idx.inj);
    const gft = num(rows[i], idx.gft);
    const fct = num(rows[i], idx.fct);

    let rpi = NaN, aep = NaN;
    if(!isNaN(cve) && !isNaN(mapv)) rpi = cve*mapv*rpm/1e6;
    if(!isNaN(cve) && !isNaN(lambda) && lambda>0 && !isNaN(lambdaTarget) && lambdaTarget>0){
      aep = cve/(lambda/lambdaTarget);
    }

    let grade = NaN;
    if(dashTimeline && ecuAbsTime && !isNaN(ecuAbsTime[i])){
      const g = dashTimeline.gradeAt(ecuAbsTime[i], 1.5, params.gradeMinDist, params.gradePlausMax);
      if(!isNaN(g)) grade = g;
    }

    let pHP = NaN, torqueNm = NaN, accelMs2 = NaN, vMs = NaN, rhoUsed = NaN;
    if(rec.hasPowerChannels && rec.usePower){
      let a = num(rows[i], idx.accel);
      if(!isNaN(a) && params.accelUnit==='g') a = a*gAll;
      const gearN = num(rows[i], idx.gear);
      const gs = num(rows[i], idx.gpsSpeed);
      const v = resolveVelocityMs(rpm, gearN, gs, params);
      if(!isNaN(v) && v>0 && !isNaN(a)){
        const rhoHere = rhoSample ? rhoSample[i] : params.rho;
        accelMs2 = a; vMs = v; rhoUsed = rhoHere;
        // Força de tração, correção de rampa e conversão pra potência/torque vivem em calc.js —
        // ver nota lá sobre por que a correção de rampa não é automática (precisa de dashboard).
        const gradeExtra = calcGradeForceExtra(params, grade, gAll);
        const F = calcTractionForce(params, a, v, rhoHere, gradeExtra, gAll);
        const pt = calcPowerTorqueFromForce(F, v, rpm);
        pHP = pt.pHP; torqueNm = pt.torqueNm;
      }
    }

    return {
      rpm, bin: Math.floor(rpm/params.binSize)*params.binSize,
      gear: num(rows[i], idx.gear),
      cve, map:mapv, lambda, lambdaTarget, inj, gft, fct, rpi, aep, pHP, torqueNm, grade,
      accel: accelMs2, v: vMs, rho: rhoUsed
    };
  }

  for(let i=0;i<N;i++){
    if(etExcluded[i]){ etExcludedCount++; continue; }

    // filtro de marcha: descarta 1ª marcha (só aplicável quando o canal existe)
    if(params.gearFilter && idx.gear>=0){
      const gearRaw = num(rows[i], idx.gear);
      if(!isNaN(gearRaw) && Math.round(gearRaw)===1) continue;
    }

    // validade do fix de GPS: descarta GPS Fix Status == 0 (só aplicável quando o canal existe)
    if(params.gpsFixFilter && idx.gpsFix>=0){
      const fix = num(rows[i], idx.gpsFix);
      if(!isNaN(fix) && fix===0) continue;
    }

    // piso de velocidade mínima do GPS Speed (só aplicável quando o canal existe)
    if(idx.gpsSpeed>=0){
      const gs = num(rows[i], idx.gpsSpeed);
      if(!isNaN(gs) && gs < params.speedMinKmh) continue;
    }

    // despique de salto de GPS Speed (glitch de reaquisição não pego pelo GPS Fix Status)
    if(gpsSpeedExcluded[i]) continue;

    // despique de transição de TP (amostra logo após mudança brusca de acelerador)
    if(tpExcluded[i]) continue;

    const tp = num(rows[i], idx.tp);
    const pedal = num(rows[i], idx.pedal);
    const loadVal = !isNaN(tp) ? tp : pedal;

    const rpm = num(rows[i], idx.rpm);
    if(isNaN(rpm) || rpm<=0) continue;
    if(isNaN(loadVal)) continue;

    const isWOT = loadVal >= params.wotThreshold;
    const isPartial = !isWOT && loadVal >= params.loadMin && loadVal <= params.loadMax;
    if(!isWOT && !isPartial) continue;

    // aceleração mínima (limiar diferente por regime) e máxima plausível (ambos os regimes),
    // convertidas para g independente da unidade do log
    if(idx.accel>=0){
      let ag = num(rows[i], idx.accel);
      if(!isNaN(ag)){
        if(params.accelUnit==='ms2') ag = ag/gAll;
        const minAccel = isWOT ? params.accelMinWot : params.accelMinMid;
        if(ag < minAccel) continue;
        if(ag > params.accelMax) continue;
      }
    }

    if(isWOT){ wotCount++; out.push(computeSample(i, rpm, tp, pedal)); }
    else { loadCount++; outLoad.push(computeSample(i, rpm, tp, pedal)); }
  }

  return {
    fileId:rec.id, fileName:rec.name, tag:rec.tag, N,
    wotCount, etExcludedCount, loadCount, preCrankBaroKPa,
    gradeCoverage: {
      n: out.concat(outLoad).filter(s=>!isNaN(s.grade)).length,
      total: out.length+outLoad.length
    },
    hasPowerChannels: rec.hasPowerChannels, usePower: rec.usePower,
    qc: rec.qc, samples: out, samplesPartial: outLoad
  };
}

function aggregate(fileResults, params, sampleKey){
  sampleKey = sampleKey || 'samples';
  const byTag = {};
  fileResults.forEach(fr=>{
    if(!byTag[fr.tag]) byTag[fr.tag] = [];
    byTag[fr.tag] = byTag[fr.tag].concat(fr[sampleKey].map(s=>Object.assign({fileId:fr.fileId, usePower:fr.usePower}, s)));
  });
  const tags = Object.keys(byTag);

  // bins present across all
  const binSet = new Set();
  tags.forEach(t=>byTag[t].forEach(s=>binSet.add(s.bin)));
  const bins = Array.from(binSet).sort((a,b)=>a-b);

  const stat = computeStatFromByTag(byTag, tags, bins, params);
  return {tags, bins, stat, byTag};
}

// ---------- preparo de amostras para calibração ----------
// Mesma ideia de processFile, mas filtrando só pra um mapa+marcha específicos e devolvendo
// {rpm, a, v, constF} pronto pro cálculo rápido de calibração (computeCalibPowerFast, em
// calc.js) reprocessar em cada combinação de Cx·A/inércia sem tocar nos arquivos de novo.
// Reaproveita os mesmos 4 filtros de detecção que processFile usa (ver acima) — antes desta
// refatoração, esta função tinha uma cópia própria desses filtros, sem o fallback de pedal que
// processFile já tinha, então um log só com Pedal Position (sem canal de TP) ficava sem filtro
// de estabilidade nenhum e sem detectar WOT na calibração. Corrigido ao unificar.
function getEligibleCalibRows(tag, gearWanted, params, dashTimeline){
  const out = [];
  const gAll = 9.80665;
  aggregated._fileResults.filter(fr=>fr.tag===tag && fr.usePower).forEach(fr=>{
    const rec = files.find(f=>f.id===fr.fileId);
    if(!rec) return;
    const headers = rec.headers, rows = rec.rows;
    const idx = {
      accel: headers.indexOf('Acceleration'),
      gear: headers.indexOf('Analyzer Calculate Gear'),
      rpm: headers.indexOf('Engine Speed'),
      gpsSpeed: headers.indexOf('GPS Speed'),
      gpsFix: headers.indexOf('GPS Fix Status'),
      gpsDate: headers.indexOf('GPS UTC Date'),
      gpsTime: headers.indexOf('GPS UTC Time'),
      gpsSats: headers.indexOf('GPS Sats Used'),
      tp: headers.indexOf('Throttle Position TP TP1L'),
      pedal: headers.indexOf('Pedal 1 Position PP1'),
      et: headers.indexOf('Engine Temperature ET'),
      dt: headers.indexOf('Datalog Time'),
    };

    let ecuAbsTime = null;
    if(dashTimeline && idx.gpsDate>=0 && idx.gpsTime>=0){
      ecuAbsTime = buildAbsoluteTimeline(rows, idx.dt, idx.gpsDate, idx.gpsTime, idx.gpsSats, DASH_MIN_SATS).absTime;
    }

    const etExcluded = detectEtExclusion(rows, idx.et, params);
    const gsExcluded = detectGpsSpeedDespike(rows, idx.gpsSpeed, params);
    const tpExcluded = detectTpTransientExclusion(rows, idx.tp, idx.pedal, params);

    for(let i=0;i<rows.length;i++){
      if(etExcluded[i]) continue;
      const gearN = num(rows[i], idx.gear);
      if(Math.round(gearN)!==gearWanted) continue;
      const loadVal = resolveLoadValue(rows, i, idx.tp, idx.pedal);
      if(isNaN(loadVal) || loadVal < params.wotThreshold) continue;
      if(tpExcluded[i]) continue;
      const et = num(rows[i], idx.et);
      if(isNaN(et) || et<params.etMin || et>params.etMax) continue;
      if(params.gpsFixFilter && idx.gpsFix>=0){
        const fix = num(rows[i], idx.gpsFix);
        if(!isNaN(fix) && fix===0) continue;
      }
      if(gsExcluded[i]) continue;
      const rpm = num(rows[i], idx.rpm);
      if(isNaN(rpm) || rpm<=0) continue;
      let a = num(rows[i], idx.accel);
      if(isNaN(a)) continue;
      if(params.accelUnit==='g') a = a*gAll;
      const ag = a/gAll;
      if(ag < params.accelMinWot) continue;
      if(ag > params.accelMax) continue;
      const gs = num(rows[i], idx.gpsSpeed);
      if(!isNaN(gs) && gs < params.speedMinKmh) continue;
      const v = resolveVelocityMs(rpm, gearWanted, gs, params);
      if(isNaN(v) || v<=0) continue;

      // Parte constante da força de tração que NÃO depende de Cx·A/inércia (rolamento + rampa,
      // se aplicável) — pré-computada aqui pra não recalcular a cada combinação da busca.
      let constF = params.crr*params.mass*gAll;
      if(params.applyGradeCorrection && dashTimeline && ecuAbsTime && !isNaN(ecuAbsTime[i])){
        const g = dashTimeline.gradeAt(ecuAbsTime[i], 1.5, params.gradeMinDist, params.gradePlausMax);
        constF += calcGradeForceExtra(params, g, gAll);
      }
      out.push({rpm, a, v, constF});
    }
  });
  return out;
}

