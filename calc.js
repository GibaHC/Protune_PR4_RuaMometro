// ---- Força de tração, correção de rampa e conversão para potência/torque ----
// Núcleo físico do projeto, usado em 3 lugares: cálculo por amostra (processFile em data.js),
// reconstrução de mapas salvos (unpackSamplesBinary, abaixo) e busca de calibração
// (getEligibleCalibRows/computeCalibPowerFast, abaixo). Centralizado aqui pra não ter 3 cópias
// da mesma fórmula divergindo com o tempo — e é o candidato natural pra virar WASM no futuro,
// já que são funções puras (mesma entrada, mesma saída, sem tocar DOM/estado global).
const GRAVITY_MS2 = 9.80665;

// F_extra = m·g·sen(θ), onde θ vem do grade% medido (Δaltitude/distância). Retorna 0 quando a
// correção está desligada ou o grade não é válido pra essa amostra (sem cobertura de altitude,
// ou descartado pelos filtros de plausibilidade/distância mínima da janela de GPS) — nesses
// casos a força de tração simplesmente não recebe o termo extra, não vira NaN.
function calcGradeForceExtra(params, grade, gAll){
  gAll = gAll || GRAVITY_MS2;
  if(!params.applyGradeCorrection || isNaN(grade)) return 0;
  const theta = Math.atan(grade/100);
  return params.mass*gAll*Math.sin(theta);
}

// F_tração = m·inércia·a + arrasto aerodinâmico + rolamento + (rampa, se houver)
function calcTractionForce(params, aMs2, v, rhoHere, gradeForceExtra, gAll){
  gAll = gAll || GRAVITY_MS2;
  return params.mass*params.inertiaFactor*aMs2
       + 0.5*rhoHere*params.cda*v*v
       + params.crr*params.mass*gAll
       + (gradeForceExtra||0);
}

// P = F·v; wHP = P/745.7; torque(N·m) = (P/1000)·9549/rpm — convenção padrão, sempre rpm do motor
function calcPowerTorqueFromForce(F, v, rpm){
  const pW = F*v;
  return { pHP: pW/745.7, torqueNm: (pW/1000)*9549/rpm };
}

function gpsToEpoch(dateVal, timeVal){
  if(isNaN(dateVal) || isNaN(timeVal) || dateVal<=0) return NaN;
  const d = Math.floor(dateVal/10000), mo = Math.floor((dateVal%10000)/100), y = dateVal%100;
  const hh = Math.floor(timeVal/10000), mm = Math.floor((timeVal%10000)/100), ss = timeVal%100;
  if(d<1||d>31||mo<1||mo>12) return NaN;
  return Date.UTC(2000+y, mo-1, d, hh, mm, Math.floor(ss), Math.round((ss%1)*1000))/1000;
}

function haversineMeters(lat1,lon1,lat2,lon2){
  const R=6371000, toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// ---- Densidade do ar: pressão barométrica por altitude + lei dos gases (ar seco/úmido) ----
const R_DRY = 287.05;   // J/(kg·K)
const R_VAPOR = 461.5;  // J/(kg·K)

// Atmosfera padrão internacional (ISA), válida na troposfera.
function pressureFromAltitude(h){
  const P0=101325, L=0.0065, T0=288.15, g=9.80665, M=0.0289644, Rgas=8.3144598;
  const exp = (g*M)/(Rgas*L); // ~5.2559
  return P0*Math.pow(1-(L*h)/T0, exp); // Pa
}

// Inverso da fórmula acima — só usado para exibir a altitude implícita da pressão barométrica
// medida (não entra em nenhum cálculo, é conferência visual pro usuário).
function altitudeFromPressureKPa(P_kPa){
  const P0=101325, L=0.0065, T0=288.15, g=9.80665, M=0.0289644, Rgas=8.3144598;
  const exp = (g*M)/(Rgas*L);
  return (T0/L)*(1-Math.pow((P_kPa*1000)/P0, 1/exp));
}

// Pressão barométrica medida pelo próprio sensor de MAP do carro: com o motor desligado
// (RPM=0) e chave ligada, o coletor de admissão está exposto à pressão atmosférica ambiente
// (sem o motor puxando vácuo) — o MAP é, nesse instante, um barômetro. Mais preciso que uma
// altitude fixa assumida, porque captura a pressão real do dia (clima), não só a altitude.
// Pega o trecho de RPM=0 contíguo a partir do início do arquivo (pré-partida) e usa a mediana
// dos últimos ~3s desse trecho (mais perto do instante de partida, robusto a ruído).
function saturationVaporPressureKPa(tC){
  return 0.61094*Math.exp((17.625*tC)/(tC+243.04));
}

// Densidade do ar úmido: soma das parcelas de ar seco e vapor d'água.
// P_kPa = pressão atmosférica total; tC = temperatura; rhPct = umidade relativa (0-100).
function airDensityHumid(P_kPa, tC, rhPct){
  const Tk = tC+273.15;
  const Psat = saturationVaporPressureKPa(tC);
  const Pv = (rhPct/100)*Psat;      // kPa
  const Pd = Math.max(0, P_kPa-Pv); // kPa
  return (Pd*1000)/(R_DRY*Tk) + (Pv*1000)/(R_VAPOR*Tk);
}

// Densidade do ar seco (sem correção de umidade) — usada no modelo geral por amostra.
function airDensityDry(P_kPa, tC){
  const Tk = tC+273.15;
  return (P_kPa*1000)/(R_DRY*Tk);
}

// Mínimo em janela móvel retroativa por TEMPO (não por nº de amostras), via deque monotônico
// O(n). Usado para estimar temperatura externa a partir do IAT, evitando que calor retido no
// cofre do motor (parado/lenta) seja lido como ambiente — o ambiente real é sempre a MENOR
// leitura disponível numa janela recente, nunca maior que o que o motor retém.
function rollingMinByTime(times, values, windowSeconds){
  const N = times.length;
  const result = new Array(N).fill(NaN);
  const deque = []; // índices, valores crescentes
  let head = 0;
  for(let i=0;i<N;i++){
    const t = times[i], v = values[i];
    if(!isNaN(t) && !isNaN(v)){
      while(deque.length && values[deque[deque.length-1]] >= v) deque.pop();
      deque.push(i);
    }
    while(deque.length && !isNaN(times[deque[0]]) && (t - times[deque[0]]) > windowSeconds) deque.shift();
    result[i] = deque.length ? values[deque[0]] : NaN;
  }
  return result;
}

function fmtDateTime(epoch){
  if(epoch===null || isNaN(epoch)) return '—';
  return new Date(epoch*1000).toISOString().replace('T',' ').replace('Z','').slice(0,19)+' UTC';
}

function fmtSavedAt(iso){
  try{ return new Date(iso).toLocaleString('pt-BR'); } catch(e){ return iso; }
}

// ---- Empacotamento binário compacto das amostras salvas ----
// Guarda só o que não dá pra recalcular (dado bruto), não os resultados prontos: rpi/aep/bin
// são recalculados na hora de carregar, a partir de cve/map/lambda/rpm + parâmetros atuais.
// pHP/torqueNm idem, a partir de accel/v/rho (a densidade que estava valendo pra aquela
// amostra especificamente, preservando o contexto de altitude/IAT do dia, mesmo sem guardar
// altitude/IAT brutos). Não dá pra recuperar o Lambda Target por amostra quando a fonte era
// "canal do log" — ao recarregar, AEP sempre usa o "Lambda alvo" fixo atual.
const SNAPSHOT_FIELDS = ['rpm','gear','cve','map','lambda','lambdaTarget','inj','gft','fct','grade','accel','v','rho'];

function float32ArrayToBase64(f32){
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for(let i=0;i<bytes.length;i+=chunk){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
  }
  return btoa(binary);
}
function base64ToFloat32Array(b64){
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function packSamplesBinary(samples){
  const cols = SNAPSHOT_FIELDS.length;
  const arr = new Float32Array(samples.length*cols);
  samples.forEach((s,i)=>{
    SNAPSHOT_FIELDS.forEach((f,j)=>{
      const v = s[f];
      arr[i*cols+j] = (v===undefined || v===null) ? NaN : v;
    });
  });
  return { n: samples.length, cols, b64: float32ArrayToBase64(arr) };
}

// Reconstrói as amostras a partir do pacote binário, recalculando tudo que depende de
// parâmetro com os valores ATUAIS (não os de quando foi salvo) — rpi/aep, bin, pHP/torqueNm.
function unpackSamplesBinary(packed, currentParams){
  if(!packed || !packed.n) return [];
  const arr = base64ToFloat32Array(packed.b64);
  const cols = packed.cols;
  const gAll = 9.80665;
  const out = [];
  for(let i=0;i<packed.n;i++){
    const row = {};
    SNAPSHOT_FIELDS.forEach((f,j)=>{ row[f] = arr[i*cols+j]; });

    let rpi = NaN, aep = NaN;
    if(!isNaN(row.cve) && !isNaN(row.map)) rpi = row.cve*row.map*row.rpm/1e6;
    // usa o λ_target salvo por amostra (fidelidade ao que estava ativo no log original,
    // inclusive quando a fonte era "canal do log", que varia amostra a amostra); só cai
    // pro "Lambda alvo" fixo de hoje se aquele valor específico não tiver sido salvo/válido
    const ltPerSample = (!isNaN(row.lambdaTarget) && row.lambdaTarget>0) ? row.lambdaTarget : currentParams.lambdaTarget;
    if(!isNaN(row.cve) && !isNaN(row.lambda) && row.lambda>0 && ltPerSample>0){
      aep = row.cve/(row.lambda/ltPerSample);
    }

    let pHP = NaN, torqueNm = NaN;
    if(!isNaN(row.accel) && !isNaN(row.v) && row.v>0 && !isNaN(row.rho)){
      const gradeExtra = calcGradeForceExtra(currentParams, row.grade, gAll);
      const F = calcTractionForce(currentParams, row.accel, row.v, row.rho, gradeExtra, gAll);
      const pt = calcPowerTorqueFromForce(F, row.v, row.rpm);
      pHP = pt.pHP; torqueNm = pt.torqueNm;
    }

    row.bin = Math.floor(row.rpm/currentParams.binSize)*currentParams.binSize;
    row.rpi = rpi; row.aep = aep; row.pHP = pHP; row.torqueNm = torqueNm;
    row.usePower = !isNaN(pHP);
    out.push(row);
  }
  return out;
}


function fmtBytes(n){
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/(1024*1024)).toFixed(2)+' MB';
}

function num(row, i){ if(i<0) return NaN; const v = parseFloat(row[i]); return v; }

// ---------- aggregation ----------
function mean(arr){ const v=arr.filter(x=>!isNaN(x)); return v.length? v.reduce((a,b)=>a+b,0)/v.length : NaN; }

// Estatística de agregação por bin, configurável: média, mediana, ou média aparada.
// Mediana/aparada só têm efeito real com n suficiente; com n baixo se comportam como a média.
function binStat(arr, params){
  const v = arr.filter(x=>!isNaN(x)).sort((a,b)=>a-b);
  if(!v.length) return NaN;
  if(params.statMethod==='median'){
    const mid = Math.floor(v.length/2);
    return v.length%2 ? v[mid] : (v[mid-1]+v[mid])/2;
  }
  if(params.statMethod==='trimmed'){
    const k = Math.floor(v.length * ((params.trimPct||0)/100));
    const trimmed = (v.length - 2*k > 0) ? v.slice(k, v.length-k) : v;
    return trimmed.reduce((a,b)=>a+b,0)/trimmed.length;
  }
  return v.reduce((a,b)=>a+b,0)/v.length;
}

function computeStatFromByTag(byTag, tags, bins, params){
  // Calcula a tabela de estatísticas (n, RPI/AEP, potência, torque, escore) a partir de um
  // byTag já pronto. Separado de aggregate() (data.js) pra poder ser chamado de novo só com um
  // subconjunto de amostras (ex.: filtro de marcha nos gráficos) sem reprocessar os arquivos.
  // per tag per bin stats
  const stat = {}; // tag -> bin -> {n, rpi, aep, pHP, torqueNm, nPower, lambda, gft, fct, inj}
  tags.forEach(t=>{
    stat[t] = {};
    bins.forEach(b=>{
      const rowsInBin = (byTag[t]||[]).filter(s=>s.bin===b);
      const powerRows = rowsInBin.filter(s=>s.usePower && !isNaN(s.pHP));
      stat[t][b] = {
        n: rowsInBin.length,
        rpi: binStat(rowsInBin.map(s=>s.rpi), params),
        aep: binStat(rowsInBin.map(s=>s.aep), params),
        lambda: binStat(rowsInBin.map(s=>s.lambda), params),
        gft: binStat(rowsInBin.map(s=>s.gft), params),
        fct: binStat(rowsInBin.map(s=>s.fct), params),
        inj: binStat(rowsInBin.map(s=>s.inj), params),
        grade: binStat(rowsInBin.map(s=>s.grade), params),
        nPower: powerRows.length,
        pHP: binStat(powerRows.map(s=>s.pHP), params),
        torqueNm: binStat(powerRows.map(s=>s.torqueNm), params),
      };
    });
  });

  // Contração (shrinkage) + normalização min-max por bin -> escore composto.
  // Antes de comparar mapas num bin, puxamos a média de cada mapa em direção à média
  // ponderada geral do bin (peso n/(n+n0)). Isso impede que um mapa com poucas amostras
  // vença um bin só por ruído estatístico — quanto menor o n, mais perto do neutro.
  bins.forEach(b=>{
    const n0 = params.shrinkN0 || 0;

    function shrink(metric){
      let sumWeighted=0, sumN=0;
      tags.forEach(t=>{
        const s = stat[t][b];
        if(!isNaN(s[metric])){ sumWeighted += s[metric]*s.n; sumN += s.n; }
      });
      const pooled = sumN>0 ? sumWeighted/sumN : NaN;
      tags.forEach(t=>{
        const s = stat[t][b];
        if(isNaN(s[metric])){ s[metric+'Shrunk']=NaN; return; }
        s[metric+'Shrunk'] = (s[metric]*s.n + pooled*n0) / (s.n + n0);
      });
    }
    shrink('rpi');
    shrink('aep');

    const rpiVals = tags.map(t=>stat[t][b].rpiShrunk).filter(v=>!isNaN(v));
    const aepVals = tags.map(t=>stat[t][b].aepShrunk).filter(v=>!isNaN(v));
    const rpiMin=Math.min(...rpiVals), rpiMax=Math.max(...rpiVals);
    const aepMin=Math.min(...aepVals), aepMax=Math.max(...aepVals);
    tags.forEach(t=>{
      const s = stat[t][b];
      const nRpi = (rpiVals.length && rpiMax>rpiMin && !isNaN(s.rpiShrunk)) ? (s.rpiShrunk-rpiMin)/(rpiMax-rpiMin) : (isNaN(s.rpiShrunk)?NaN:0.5);
      const nAep = (aepVals.length && aepMax>aepMin && !isNaN(s.aepShrunk)) ? (s.aepShrunk-aepMin)/(aepMax-aepMin) : (isNaN(s.aepShrunk)?NaN:0.5);
      let score = NaN;
      if(!isNaN(nRpi) && !isNaN(nAep)) score = params.scoreWeight*nRpi + (1-params.scoreWeight)*nAep;
      else if(!isNaN(nRpi)) score = nRpi;
      else if(!isNaN(nAep)) score = nAep;
      s.score = score;
      s.confidence = s.n>=params.confHigh ? 'Alta' : (s.n>=params.confMed ? 'Média' : 'Baixa');
      s.confidencePower = s.nPower>=params.confHigh ? 'Alta' : (s.nPower>=params.confMed ? 'Média' : 'Baixa');
    });
  });

  return stat;
}

// Recalcula o stat de um agg já existente, restrito às marchas selecionadas — usado pelo
// filtro de marcha acima dos gráficos. Não mexe no byTag original (fonte da verdade continua
// com todas as marchas), só filtra na hora de montar a estatística exibida.
function applyGearFilterToAgg(agg, selectedGears){
  if(!agg) return;
  const filteredByTag = {};
  agg.tags.forEach(t=>{
    filteredByTag[t] = agg.byTag[t].filter(s=>selectedGears.has(Math.round(s.gear)));
  });
  agg.stat = computeStatFromByTag(filteredByTag, agg.tags, agg.bins, agg._params);
}

function fmt(v, d){ return isNaN(v)||v===undefined||v===null ? '—' : v.toFixed(d===undefined?2:d); }

function bestPowerTagInBin(stat, tags, b){
  let best=null, bestVal=-Infinity;
  tags.forEach(t=>{
    const s = stat[t][b];
    if(s.nPower>0 && s.confidencePower!=='Baixa' && s.pHP>bestVal){ bestVal=s.pHP; best=t; }
  });
  return best;
}

// Cálculo rápido por combinação de Cx·A/inércia, reaproveitando as linhas já filtradas acima —
// é só aritmética sobre um array, sem tocar nos arquivos brutos de novo. Não usa calcTractionForce
// (que recalcularia rolamento+rampa em cada combinação) — reaproveita só o formato final
// força->potência/torque, que é comum aos 3 lugares que fazem esse cálculo no projeto.
function computeCalibPowerFast(eligibleRows, cda, inertia, params){
  return eligibleRows.map(r=>{
    const F = params.mass*inertia*r.a + 0.5*params.rho*cda*r.v*r.v + r.constF;
    const pt = calcPowerTorqueFromForce(F, r.v, r.rpm);
    return {rpm:r.rpm, pHP: pt.pHP, torqueNm: pt.torqueNm};
  });
}

