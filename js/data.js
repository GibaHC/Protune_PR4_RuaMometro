// ---------- estado global compartilhado ----------
// Vive aqui (data.js) porque é o núcleo de dados do projeto; dom.js lê/mostra, calc.js só usa
// o que já está processado (nunca modifica estes arrays/objetos diretamente).
let files = []; // {id,name, headers, rows, tag, sessionLabel, hasPowerChannels, usePower, qc, N} — arquivos de ECU carregados
let dashFiles = []; // {id,name,headers,rows,N,summary} — logs de dashboard, usados só para enriquecer com altitude/rampa
let aggregated = null; // último resultado de processamento (WOT) — ver aggregate()
let aggregatedMid = null; // último resultado de processamento (carga média / parcial)
let fileIdSeq = 0;
let tagOrder = []; // ordem de exibição dos mapas nos gráficos/tabelas/legendas, controlada pelo usuário
let customTagPatterns = []; // nomes de mapa adicionados pelo usuário pra detecção automática (seção 01) — ver classify()

const CUSTOM_TAGS_STORAGE_KEY = 'comparador_mapas_injecao_custom_tags_v1';
// Lê a lista de nomes customizados do localStorage. Lista vazia se não houver nada salvo ou
// se o navegador bloquear/der erro de leitura (nunca lança exceção pra fora).
function loadCustomTagsFromStorage(){
  try{
    const raw = localStorage.getItem(CUSTOM_TAGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ return []; }
}
// Grava a lista inteira de volta no localStorage. Devolve false (em vez de lançar) se falhar.
function writeCustomTagsToStorage(list){
  try{ localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify(list)); return true; } catch(e){ return false; }
}

// Classifica um arquivo de ECU num "mapa" (tag) a partir do nome do arquivo: primeiro confere
// os nomes customizados adicionados pelo usuário (seção 01, ordem de inclusão = prioridade),
// depois os padrões embutidos — soma_NN/tira_NN/calib_NN (presente e futuro, com ou sem
// underscore/hífen), calib solto, base/vvt — e cai em "custom" se nada bater. É a base de tudo
// que agrupa/compara por mapa.
function classify(filename){
  const f = filename.toLowerCase();
  // Fronteira "não-alfanumérico" (aceita _, -, início/fim como separador) — diferente do
  // "[^a-z]" usado pelos padrões embutidos abaixo, aqui dígito TAMBÉM conta como parte da
  // palavra, não como separador. Isso importa porque nome customizado plausivelmente termina
  // em número (ex.: "avanco_5") e um dígito colado não pode contar como fronteira, senão
  // "avanco_5" bateria por engano dentro de "avanco_50".
  for(const pattern of customTagPatterns){
    const re = new RegExp('(^|[^a-z0-9])'+escapeRegExp(pattern.toLowerCase())+'([^a-z0-9]|$)');
    if(re.test(f)) return pattern;
  }
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

// Procura, entre os arquivos já carregados (ECU + dashboard), um que pareça ser o mesmo que o
// candidato (name/size/lastModified vêm direto do objeto File, sem custo de leitura).
// metaOnly=true (checagem antes de ler o arquivo) só compara metadado; com contentHash
// disponível (depois da leitura), também confere o hash de conteúdo — pega até arquivo
// renomeado ou com data de modificação diferente, mas exatamente o mesmo texto.
function findDuplicateRecord(name, size, lastModified, contentHash, metaOnly){
  const all = files.concat(dashFiles);
  for(const rec of all){
    if(rec.name===name && rec.size===size && rec.lastModified===lastModified){
      return {rec, matchType:'metadado (nome/tamanho/data)'};
    }
    if(!metaOnly && contentHash && rec.contentHash && rec.contentHash===contentHash){
      return {rec, matchType:'conteúdo idêntico'};
    }
  }
  return null;
}

// Classifica um arquivo como dashboard (TDL) em vez de ECU: tem canal de altitude do GPS
// e NÃO tem Corrected VE (canal exclusivo do log de ECU). Dashboards só servem pra enriquecer
// os arquivos de ECU com altitude/rampa — nunca entram no processamento de potência/mapa.
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
  const sessionStarts = [];
  let offset = null, sessionCount = 0;
  for(let i=0;i<N;i++){
    const dt = num(rows[i], idxDT);
    const sats = idxSats>=0 ? num(rows[i], idxSats) : Infinity;
    const rawEpoch = gpsToEpoch(num(rows[i],idxDate), num(rows[i],idxTime));
    if(!isNaN(rawEpoch) && (idxSats<0 || sats>=minSats)){
      const candidate = rawEpoch - dt;
      if(offset===null || Math.abs(candidate-offset) > 3){ offset = candidate; sessionCount++; sessionStarts.push(i); }
      else offset = offset*0.98 + candidate*0.02;
    }
    if(offset!==null) absTime[i] = dt + offset;
  }
  return {absTime, sessionCount, sessionStarts};
}

// Pressão barométrica medida pelo próprio sensor de MAP do carro: com o motor desligado
// (RPM=0) e chave ligada, o coletor de admissão está exposto à pressão atmosférica ambiente
// (sem o motor puxando vácuo) — o MAP é, nesse instante, um barômetro. Mais preciso que uma
// altitude fixa assumida, porque captura a pressão real do dia (clima), não só a altitude.
// Detecta isso pra CADA sessão de gravação dentro do arquivo (sessionStarts, de
// buildAbsoluteTimeline), não só a primeira — importante pra arquivo com sessões concatenadas
// (equipamento desligado/religado, ou merge de dias diferentes), onde a pressão atmosférica
// real pode ser diferente sessão a sessão. Pra cada sessão: pega o bloco de RPM=0 contíguo a
// partir do início dela e usa a mediana dos últimos ~3s desse trecho (mais perto do instante de
// partida, robusto a ruído). Devolve um array de {startIdx, baroKPa} — baroKPa é NaN pra uma
// sessão sem bloco de RPM=0 longo o bastante pra confiar (cai no próximo nível de prioridade
// pra essas linhas especificamente, ver rhoSample em processFile).
function detectPreCrankBaroKPa(rows, idxRpm, idxMap, idxDt, sessionStarts){
  if(idxRpm<0 || idxMap<0) return [];
  const N = rows.length;
  const boundaries = (sessionStarts && sessionStarts.length) ? sessionStarts : [0];
  return boundaries.map((sessionStart, si)=>{
    const sessionEnd = (si+1<boundaries.length) ? boundaries[si+1] : N;
    let end = sessionStart;
    while(end<sessionEnd){
      const rpm = num(rows[end], idxRpm);
      if(isNaN(rpm) || rpm>0) break;
      end++;
    }
    if(end-sessionStart < 3) return {startIdx: sessionStart, baroKPa: NaN}; // trecho curto demais pra confiar
    let start = sessionStart;
    if(idxDt>=0){
      const tEnd = num(rows[end-1], idxDt);
      start = end-1;
      while(start>sessionStart && (tEnd - num(rows[start-1], idxDt)) <= 3) start--;
    } else {
      start = Math.max(sessionStart, end-60);
    }
    const vals = [];
    for(let i=start;i<end;i++){ const v=num(rows[i], idxMap); if(!isNaN(v)) vals.push(v); }
    if(vals.length<3) return {startIdx: sessionStart, baroKPa: NaN};
    vals.sort((a,b)=>a-b);
    return {startIdx: sessionStart, baroKPa: vals[Math.floor(vals.length/2)]};
  });
}

// Acha a pressão pré-partida válida pra linha i, olhando pra trás até a última sessão cujo
// baroKPa foi detectável — assim uma sessão sem leitura própria não fica sem nenhum valor à
// toa (usa a da sessão anterior mais próxima) em vez de cair direto no fallback de altitude fixa.
function baroForRow(preCrankSessions, i){
  let result = NaN;
  for(const s of preCrankSessions){
    if(s.startIdx>i) break;
    if(!isNaN(s.baroKPa)) result = s.baroKPa;
  }
  return result;
}

// Parâmetros fixos do enriquecimento por dashboard: quantos satélites mínimos pra confiar num
// ponto de GPS, tamanho da janela de suavização de altitude, e gap máximo de tempo (segundos)
// além do qual não se interpola entre dois pontos (sem cobertura real, não inventa dado).
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

// Pra cada canal futuro, verifica se a coluna existe no cabeçalho e, se existir, se tem
// algum valor real (não-zero) em qualquer linha — distingue "coluna presente mas zerada"
// (sensor ainda não ligado na rede CAN) de "populada de verdade" (pronta pra uso).
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

// Resumo de um arquivo de dashboard pra tabela de arquivos: cobertura de GPS válido (%),
// faixa de altitude, intervalo de tempo coberto, e status dos canais futuros (acima).
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

// Constrói a timeline de altitude/posição a partir de TODOS os dashboards carregados, unificados
// e ordenados por tempo absoluto, com suavização por média móvel (janela DASH_SMOOTH_WINDOW).
// Devolve altAt(t)/gradeAt(t) — interpolação de altitude e cálculo de grade% entre dois instantes.
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

// Checagem de qualidade de um arquivo de ECU logo no carregamento (antes de processar de
// verdade): acusa canal de aceleração/marcha ausente, aceleração "achatada" (variância baixa
// demais, sinal de canal com defeito) e marcha travada em 1 mesmo com rpm alto (log com
// problema no sensor/config de marcha). "severe" desabilita o uso do arquivo pra potência.
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

// Limpa do localStorage qualquer chave de formato de armazenamento já superado (ver
// DEPRECATED_STORAGE_KEYS) — roda sozinho no carregamento da página, sem ação do usuário.
// Mantenha essa lista atualizada a cada vez que MAPS_STORAGE_KEY subir de versão.
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

// Lê a lista de sessões de mapas salvos (seção 07) do localStorage. Lista vazia se não houver
// nada salvo ou se o navegador bloquear/der erro de leitura (nunca lança exceção pra fora).
function loadSavedMapsList(){
  try{
    const raw = localStorage.getItem(MAPS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ return []; }
}
// Grava a lista inteira de volta no localStorage. Devolve false (em vez de lançar) se falhar
// — normalmente por armazenamento cheio ou bloqueado pelo navegador.
function writeSavedMapsList(list){
  try{ localStorage.setItem(MAPS_STORAGE_KEY, JSON.stringify(list)); return true; } catch(e){ return false; }
}
// ---------- filtros de linha compartilhados (usados por processFile E getEligibleCalibRows) ----------
// Extraídos pra não ter duas implementações divergindo com o tempo — antes, a calibração tinha
// uma cópia independente desses 4 filtros, sem o fallback de pedal que o processamento principal
// já tinha (log só com Pedal Position, sem canal de TP, ficava sem filtro nenhum na calibração).

// Valor de carga (TP ou Pedal, o que estiver disponível) — usado tanto pra decidir WOT/carga
// parcial quanto pra medir estabilidade de aceleração. TP tem prioridade quando os dois existem.
function resolveLoadValue(rows, i, idxTp, idxPedal){
  const tp = num(rows[i], idxTp);
  const pedal = num(rows[i], idxPedal);
  return !isNaN(tp) ? tp : pedal;
}

// Exclusão por temperatura do motor (ET): descarta amostra com ET fora da faixa plausível
// (etMin/etMax) OU com salto brusco de uma amostra pra outra (etMaxDelta, indício de leitura
// ruim do sensor) — e expande a exclusão por uma janela ao redor (etWindow), já que um sensor
// instável raramente falha numa amostra isolada.
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

// ---------- processamento por arquivo ----------
// Transforma um arquivo de ECU já carregado (headers+rows brutos do CSV) em duas listas de
// amostras tratadas — WOT (samples) e carga parcial (samplesPartial) — já com todos os filtros
// de qualidade aplicados e RPI/AEP/potência/torque calculados por amostra. É o coração do
// tratamento de dado do projeto: cada filtro abaixo existe por um motivo concreto encontrado
// em log real (ver comentário de cada um no loop principal, mais adiante nesta função).
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

  // Timeline absoluta deste próprio arquivo de ECU: sempre construída (não só quando há
  // dashboard) porque a detecção de sessão dela alimenta a barometria pré-partida por sessão
  // logo abaixo, que não depende de dashboard nenhum — só o casamento com altitude do GPS
  // (ecuAbsTime usado mais adiante) depende de dashTimeline existir.
  let ecuAbsTime = null, sessionStarts = [0];
  if(idx.gpsDate>=0 && idx.gpsTime>=0){
    const tl = buildAbsoluteTimeline(rows, idx.dt, idx.gpsDate, idx.gpsTime, idx.gpsSats, DASH_MIN_SATS);
    sessionStarts = tl.sessionStarts.length ? tl.sessionStarts : [0];
    if(dashTimeline) ecuAbsTime = tl.absTime;
  }

  // Densidade do ar por amostra: pressão em 3 níveis de prioridade —
  //  1) altitude do GPS (dashboard), quando disponível e habilitado — mais granular, varia
  //     amostra a amostra com o terreno percorrido;
  //  2) pressão barométrica medida no pré-partida (RPM=0), por SESSÃO dentro deste arquivo
  //     (ver detectPreCrankBaroKPa) — constante dentro de uma sessão, mas é pressão REAL
  //     medida naquele dia específico, não uma altitude assumida; arquivo com sessões de dias
  //     diferentes (ex.: merge de múltiplas sessões) usa a pressão de cada dia separadamente;
  //  3) altitude fixa do projeto (fallback genérico), via fórmula barométrica padrão.
  // + temperatura do piso de IAT numa janela móvel (evita ler calor retido no cofre do motor
  // como se fosse ambiente). Sem canal de IAT, cai no ρ fixo de fallback da seção 02.
  const preCrankSessions = detectPreCrankBaroKPa(rows, idx.rpm, idx.map, idx.dt, sessionStarts);
  let rhoSample = null;
  if(idx.iat>=0 && idx.dt>=0){
    const dtVals = new Array(N), iatVals = new Array(N);
    for(let i=0;i<N;i++){ dtVals[i] = num(rows[i], idx.dt); iatVals[i] = num(rows[i], idx.iat); }
    const iatFloor = rollingMinByTime(dtVals, iatVals, params.iatWindowMin*60);
    rhoSample = new Array(N);
    for(let i=0;i<N;i++){
      let P_kPa;
      const preCrankHere = baroForRow(preCrankSessions, i);
      if(params.useGpsAltitude && dashTimeline && ecuAbsTime && !isNaN(ecuAbsTime[i]) && dashTimeline.altAt(ecuAbsTime[i])){
        P_kPa = pressureFromAltitude(dashTimeline.altAt(ecuAbsTime[i]).alt)/1000;
      } else if(!isNaN(preCrankHere)){
        P_kPa = preCrankHere;
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

  // Calcula todos os campos derivados de UMA amostra (índice i da linha) já aprovada pelos
  // filtros do loop principal abaixo: RPI/AEP (eficiência), grade da rampa nesse instante
  // (se houver dashboard), e potência/torque (se o arquivo tiver canais de aceleração/marcha).
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

  // Loop principal: cada linha do arquivo passa por uma sequência de filtros independentes,
  // em ordem. Qualquer filtro que rejeita a linha usa "continue" e pula pro próximo — uma
  // amostra só chega em computeSample() se passar por TODOS. A ordem abaixo não é por
  // desempenho, é só a ordem em que os filtros foram adicionados ao projeto; qualquer um pode
  // ser lido isoladamente sem depender dos outros.
  for(let i=0;i<N;i++){
    // 1) Temperatura do motor (ET): já pré-computado acima (detectEtExclusion) porque depende
    // de olhar amostras vizinhas (janela), não só a linha atual.
    if(etExcluded[i]){ etExcludedCount++; continue; }

    // 2) Filtro de marcha: descarta 1ª marcha quando a opção está ligada (só aplicável se o
    // canal de marcha existir no arquivo). Motivo: 1ª marcha tem poucas amostras WOT (troca
    // rápida) e maior variância de potência estimada — ver achado de viés de trecho de pista
    // específico por marcha, documentado na investigação de "potência exagerada em 2ª marcha".
    if(params.gearFilter && idx.gear>=0){
      const gearRaw = num(rows[i], idx.gear);
      if(!isNaN(gearRaw) && Math.round(gearRaw)===1) continue;
    }

    // 3) Validade do fix de GPS: descarta amostra com GPS Fix Status == 0 (sem posição válida
    // naquele instante) quando a opção está ligada e o canal existe.
    if(params.gpsFixFilter && idx.gpsFix>=0){
      const fix = num(rows[i], idx.gpsFix);
      if(!isNaN(fix) && fix===0) continue;
    }

    // 4) Piso de velocidade mínima do GPS Speed: abaixo disso (ex.: manobra de box, saída de
    // pista) a leitura de velocidade fica proporcionalmente mais ruidosa e não representa
    // condução real em avaliação.
    if(idx.gpsSpeed>=0){
      const gs = num(rows[i], idx.gpsSpeed);
      if(!isNaN(gs) && gs < params.speedMinKmh) continue;
    }

    // 5) Despique de salto de GPS Speed: um "fix válido" às vezes volta um pouco antes da
    // solução de velocidade estabilizar de verdade após perda de sinal — gera um salto de
    // velocidade fisicamente impossível entre amostras consecutivas sem que o GPS Fix Status
    // (filtro 3) acuse isso sozinho. Pré-computado acima (detectGpsSpeedDespike).
    if(gpsSpeedExcluded[i]) continue;

    // 6) Despique de transição de TP/Pedal: descarta amostra dentro de uma janela de
    // instabilidade do acelerador (pé subindo/descendo), mesmo que não seja um degrau único —
    // pega também transições lentas de várias amostras (lift-e-retomada). Pré-computado acima
    // (detectTpTransientExclusion).
    if(tpExcluded[i]) continue;

    // 7) Resolve o valor de carga (TP com prioridade, Pedal como alternativa) — usado tanto
    // pra classificar WOT/carga parcial quanto, mais abaixo, como entrada de computeSample.
    const tp = num(rows[i], idx.tp);
    const pedal = num(rows[i], idx.pedal);
    const loadVal = !isNaN(tp) ? tp : pedal;

    // 8) RPM precisa existir e ser positivo — sem isso não há nem bin de rpm nem cálculo físico
    // possível.
    const rpm = num(rows[i], idx.rpm);
    if(isNaN(rpm) || rpm<=0) continue;
    // 9) Precisa ter algum valor de carga válido (TP ou Pedal) pra classificar o regime abaixo.
    if(isNaN(loadVal)) continue;

    // 10) Classificação de regime: WOT (carga ≥ limiar) ou carga parcial (dentro da faixa
    // configurada, sem entrar em WOT). Fora dessas duas janelas, a amostra não interessa pra
    // nenhuma das duas comparações (nem WOT nem parcial) e é descartada.
    const isWOT = loadVal >= params.wotThreshold;
    const isPartial = !isWOT && loadVal >= params.loadMin && loadVal <= params.loadMax;
    if(!isWOT && !isPartial) continue;

    // 11) Aceleração mínima (limiar diferente por regime — WOT exige mais que carga parcial,
    // que pode incluir cruzeiro quase estável) e máxima plausível (mesmo limiar pros dois
    // regimes, corta pico de aceleração fisicamente implausível/glitch). Convertida pra g
    // independente da unidade configurada do log.
    if(idx.accel>=0){
      let ag = num(rows[i], idx.accel);
      if(!isNaN(ag)){
        if(params.accelUnit==='ms2') ag = ag/gAll;
        const minAccel = isWOT ? params.accelMinWot : params.accelMinMid;
        if(ag < minAccel) continue;
        if(ag > params.accelMax) continue;
      }
    }

    // Passou por todos os filtros — calcula os campos derivados e guarda na lista certa.
    if(isWOT){ wotCount++; out.push(computeSample(i, rpm, tp, pedal)); }
    else { loadCount++; outLoad.push(computeSample(i, rpm, tp, pedal)); }
  }


  // Pra exibição no QC (uma linha por arquivo): a primeira leitura válida entre as sessões
  // detectadas, mais a lista completa (preCrankSessions) pra quem precisar do detalhe por
  // sessão — o cálculo de densidade em si já usa a leitura certa de CADA sessão (baroForRow),
  // isso aqui é só o resumo mostrado na tabela.
  const firstValidBaro = preCrankSessions.find(s=>!isNaN(s.baroKPa));
  const preCrankBaroKPa = firstValidBaro ? firstValidBaro.baroKPa : NaN;

  return {
    fileId:rec.id, fileName:rec.name, tag:rec.tag, N,
    wotCount, etExcludedCount, loadCount, preCrankBaroKPa, preCrankSessions,
    gradeCoverage: {
      n: out.concat(outLoad).filter(s=>!isNaN(s.grade)).length,
      total: out.length+outLoad.length
    },
    hasPowerChannels: rec.hasPowerChannels, usePower: rec.usePower,
    qc: rec.qc, samples: out, samplesPartial: outLoad
  };
}

// Junta os resultados de processFile de todos os arquivos habilitados num único agregado por
// mapa (tag): agrupa amostras em byTag, monta a lista de bins de rpm presentes, e chama
// computeStatFromByTag (calc.js) pra montar a tabela de estatística/escore final.
// sampleKey escolhe WOT ('samples', padrão) ou carga parcial ('samplesPartial').
function aggregate(fileResults, params, sampleKey){
  sampleKey = sampleKey || 'samples';
  const byTag = {};
  fileResults.forEach(fr=>{
    if(!byTag[fr.tag]) byTag[fr.tag] = [];
    byTag[fr.tag] = byTag[fr.tag].concat(fr[sampleKey].map(s=>Object.assign({fileId:fr.fileId, usePower:fr.usePower}, s)));
  });
  const tags = Object.keys(byTag);

  // bins de rpm presentes em pelo menos um mapa (união, não interseção)
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

