// Paleta rotativa de cores por mapa (tag): "base" sempre ciano fixo (referência visual
// constante entre sessões); os demais recebem cor da paleta na ordem em que aparecem pela
// primeira vez, sem precisar tocar no código pra um teste novo (soma_60, tira_10, etc.).
const COLOR_PALETTE = ['#ff7a1a','#9d7bff','#ffb35c','#c3a6ff','#4ade80','#f472b6','#60a5fa','#facc15','#fb7185','#34d399'];
const _colorAssign = {};
let _colorIdx = 0;
function colorForTag(tag){
  if(tag==='base') return '#35c9c1';
  if(!_colorAssign[tag]){ _colorAssign[tag] = COLOR_PALETTE[_colorIdx % COLOR_PALETTE.length]; _colorIdx++; }
  return _colorAssign[tag];
}

// Move um mapa uma posição pra cima/baixo na ordem de exibição (botões ▲▼ da seção de ordem).
// direction: -1 (cima) ou +1 (baixo). Re-renderiza a lista de ordem e, se já houver dado
// processado, reaplica a ordem nos gráficos/tabelas sem precisar reprocessar os arquivos.
function moveTag(tag, direction){
  const idx = tagOrder.indexOf(tag);
  if(idx<0) return;
  const newIdx = idx+direction;
  if(newIdx<0 || newIdx>=tagOrder.length) return;
  const tmp = tagOrder[idx]; tagOrder[idx]=tagOrder[newIdx]; tagOrder[newIdx]=tmp;
  renderTagOrderUI();
  if(aggregated){ applyTagOrder(aggregated); applyTagOrder(aggregatedMid); renderResults(); renderMidResults(); }
}

// Desenha a lista de mapas com botões ▲▼ de reordenação (seção de ordem de exibição).
function renderTagOrderUI(){
  const list = currentTagsInOrder();
  const container = document.getElementById('tagOrderList');
  document.getElementById('noTags').style.display = list.length? 'none':'block';
  container.innerHTML = list.map((tag, i)=>`
    <div class="tagOrderRow">
      <span class="tagOrderRank">${i+1}</span>
      <span class="tagOrderName" style="color:${colorForTag(tag)}">${tag}</span>
      <button class="orderBtn" data-tag="${tag}" data-dir="-1" ${i===0?'disabled':''} title="Mover para cima">▲</button>
      <button class="orderBtn" data-tag="${tag}" data-dir="1" ${i===list.length-1?'disabled':''} title="Mover para baixo">▼</button>
    </div>`).join('');
  container.querySelectorAll('.orderBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>moveTag(btn.dataset.tag, parseInt(btn.dataset.dir,10)));
  });
}

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
dropZone.addEventListener('click', ()=>fileInput.click());
dropZone.addEventListener('dragover', e=>{e.preventDefault(); dropZone.classList.add('drag');});
dropZone.addEventListener('dragleave', ()=>dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e=>{
  e.preventDefault(); dropZone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e=>handleFiles(e.target.files));

// ---------- carregamento de arquivo ----------
// Lê os arquivos soltos/selecionados, um de cada vez: FileReader (leitura) + Papa.parse
// (parse), cada etapa avançando a barra de progresso da seção 01. Classifica cada arquivo
// como dashboard ou ECU (isDashFile, em data.js) e direciona pra lista certa (dashFiles/files).
function handleFiles(fileList){
  const arr = Array.from(fileList).filter(f=>/\.csv$/i.test(f.name));
  if(!arr.length) return;

  const progressWrap = document.getElementById('uploadProgressWrap');
  const progressBar = document.getElementById('uploadProgressBar');
  const progressLabel = document.getElementById('uploadProgressLabel');
  const totalFiles = arr.length;
  const totalSteps = totalFiles*2; // leitura + parse contam cada uma como metade do arquivo
  let steps = 0;
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressLabel.textContent = `lendo arquivos… 0/${totalFiles}`;

  function tickStep(label, finalLabel){
    steps++;
    const pct = 100*steps/totalSteps;
    progressBar.style.width = pct.toFixed(1)+'%';
    if(steps<totalSteps){
      progressLabel.textContent = label;
    } else {
      progressLabel.textContent = finalLabel || `concluído — ${totalFiles}/${totalFiles} arquivo(s) carregado(s)`;
      setTimeout(()=>{ progressWrap.style.display = 'none'; }, 800);
    }
  }

  arr.forEach(f=>{
    const reader = new FileReader();
    reader.onload = ev=>{
      // metade 1: leitura do arquivo (bytes -> texto) concluída
      tickStep(`lido: ${f.name} — parseando…`);
      // setTimeout(0) cede o controle pro navegador repintar a barra antes do parse síncrono
      // (Papa.parse pode travar a thread por um instante em arquivos grandes)
      setTimeout(()=>{
        const parsed = Papa.parse(ev.target.result, {skipEmptyLines:true});
        const headers = parsed.data[0];
        const rows = parsed.data.slice(1);

        if(isDashFile(headers)){
          const rec = {
            id: 'd'+(fileIdSeq++), name:f.name, headers, rows, N: rows.length
          };
          rec.summary = summarizeDashFile(rec);
          dashFiles.push(rec);
          renderDashFileTable();
          renderFileTable(); // recalcula cobertura de altitude dos arquivos de ECU já carregados
          document.getElementById('statusMsg').textContent = '';
          document.getElementById('btnProcess').disabled = files.length===0;
          // metade 2: parse + processamento concluídos
          tickStep(`parseado: ${f.name}`);
          return;
        }

        const idxAccel = headers.indexOf('Acceleration');
        const idxGear = headers.indexOf('Analyzer Calculate Gear');
        const idxRpm = headers.indexOf('Engine Speed');
        const hasPowerChannels = idxAccel>=0 && idxGear>=0;
        const qc = runQC(headers, rows, idxAccel, idxGear, idxRpm);
        const rec = {
          id: 'f'+(fileIdSeq++), name:f.name, headers, rows,
          tag: classify(f.name), sessionLabel: sessionLabel(f.name),
          hasPowerChannels, usePower: hasPowerChannels && !qc.severe,
          qc, N: rows.length
        };
        files.push(rec);
        ensureTagInOrder(rec.tag);
        renderFileTable();
        document.getElementById('statusMsg').textContent = '';
        document.getElementById('btnProcess').disabled = files.length===0;
        // metade 2: parse + processamento concluídos
        tickStep(`parseado: ${f.name}`);
      }, 0);
    };
    reader.onerror = ()=>{
      tickStep(f.name+' (erro de leitura)');
      tickStep(f.name+' (falhou)', undefined);
    };
    reader.readAsText(f);
  });
}

// Tabela de arquivos de dashboard carregados: cobertura de altitude, faixa de altitude,
// período coberto, e status dos canais futuros (badge verde=populado, âmbar=presente mas
// zerado). Botão de remover recalcula a cobertura dos arquivos de ECU sem esse dashboard.
function renderDashFileTable(){
  const wrap = document.getElementById('dashFileTableWrap');
  const empty = document.getElementById('noDashFiles');
  if(!dashFiles.length){ wrap.style.display='none'; empty.style.display='block'; return; }
  wrap.style.display='block'; empty.style.display='none';
  let h = '<table><thead><tr><th>Arquivo</th><th>Linhas</th><th>Sessões</th><th>Cobertura alt.</th><th>Faixa de altitude</th><th>Período (UTC)</th><th>Canais futuros (leitura, sem uso no cálculo)</th><th></th></tr></thead><tbody>';
  dashFiles.forEach(rec=>{
    const s = rec.summary;
    const fcBadges = s.futureChannels.map(fc=>{
      if(!fc.present) return '';
      const cls = fc.populated ? 'b-ok' : 'b-warn';
      const label = fc.populated ? `${fc.label}: ${fc.n} amostras` : `${fc.label}: aguardando`;
      return `<span class="badge ${cls}" style="margin:1px;" title="${fc.populated?'coluna presente com dado real':'coluna presente no arquivo mas ainda zerada/sem leitura — sensor em instalação'}">${label}</span>`;
    }).join(' ');
    h += `<tr><td>${rec.name.length>28?rec.name.slice(0,26)+'…':rec.name}</td><td>${rec.N}</td><td>${s.sessionCount}</td>
      <td>${fmt(s.coveragePct,0)}%</td><td>${fmt(s.altMin,0)}–${fmt(s.altMax,0)} m</td>
      <td style="white-space:normal;font-size:11px;">${fmtDateTime(s.firstT)} → ${fmtDateTime(s.lastT)}</td>
      <td style="white-space:normal;">${fcBadges || '<span style="color:var(--dimmer)">nenhuma coluna reconhecida</span>'}</td>
      <td><button data-id="${rec.id}" class="btn secondary removeDashBtn" style="padding:4px 10px;font-size:11px;">remover</button></td></tr>`;
  });
  h += '</tbody></table>';
  wrap.innerHTML = h;
  document.querySelectorAll('.removeDashBtn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      dashFiles = dashFiles.filter(x=>x.id!==e.target.dataset.id);
      renderDashFileTable();
      renderFileTable(); // recalcula cobertura de altitude sem esse arquivo de dashboard
    });
  });
}

// Cobertura de altitude do GPS por arquivo de ECU, contra os logs de dashboard já carregados.
// Recalculada sempre que a lista de arquivos ou de dashboards muda. Varre linha a linha (não
// amostra) porque a coluna de check "100%" precisa ser exata, não aproximada.
function updateAltitudeCoverage(){
  if(!dashFiles.length){
    files.forEach(rec=>{ rec.altCoverage = undefined; });
    return;
  }
  const dashTimeline = buildDashAltitudeTimeline();
  files.forEach(rec=>{
    const idx = {
      dt: rec.headers.indexOf('Datalog Time'), gpsDate: rec.headers.indexOf('GPS UTC Date'),
      gpsTime: rec.headers.indexOf('GPS UTC Time'), gpsSats: rec.headers.indexOf('GPS Sats Used')
    };
    if(!dashTimeline || idx.gpsDate<0 || idx.gpsTime<0){ rec.altCoverage = {pct:0, n:0, total:rec.rows.length}; return; }
    const absTime = buildAbsoluteTimeline(rec.rows, idx.dt, idx.gpsDate, idx.gpsTime, idx.gpsSats, DASH_MIN_SATS).absTime;
    let covered=0;
    for(let i=0;i<rec.rows.length;i++){
      if(isNaN(absTime[i])) continue;
      if(dashTimeline.altAt(absTime[i])) covered++;
    }
    rec.altCoverage = {pct: rec.rows.length ? (100*covered/rec.rows.length) : 0, n:covered, total:rec.rows.length};
  });
}

// Tabela principal de arquivos de ECU carregados: nome, sessão, mapa (editável), nº de
// amostras, disponibilidade de canais de potência, cobertura de altitude (se houver dashboard),
// selos de QC, checkbox de habilitar-pra-potência, e botão de remover. Recalcula cobertura de
// altitude e a ordem de mapas toda vez que é chamada (arquivo adicionado/removido/reclassificado).
function renderFileTable(){
  const tbl = document.getElementById('fileTable');
  const body = document.getElementById('fileTableBody');
  document.getElementById('noFiles').style.display = files.length? 'none':'block';
  tbl.style.display = files.length? 'table':'none';
  document.getElementById('fileCountLabel').textContent = files.length + ' arquivo(s) carregado(s)';
  body.innerHTML = '';

  // ordena a lista por data crescente (extraída do nome do arquivo); empate desfeito pelo nome
  files.sort((a,b)=>{
    const ka = dateSortKey(a.name), kb = dateSortKey(b.name);
    if(ka!==kb) return ka-kb;
    return a.name.localeCompare(b.name);
  });

  updateAltitudeCoverage();
  renderTagOrderUI();

  // datalist com todos os clusters já vistos (descobertos dinamicamente pelo nome do arquivo,
  // ou digitados manualmente) — não é uma lista fixa, só uma sugestão de autocompletar.
  const knownTags = Array.from(new Set(files.map(r=>r.tag).concat(['base'])));
  let dl = document.getElementById('tagDatalist');
  if(!dl){
    dl = document.createElement('datalist');
    dl.id = 'tagDatalist';
    document.body.appendChild(dl);
  }
  dl.innerHTML = knownTags.map(t=>`<option value="${t}">`).join('');

  files.forEach(rec=>{
    const tr = document.createElement('tr');

    const qcBadge = rec.qc.flags.length
      ? rec.qc.flags.map(f=>`<span class="flag flag-qc">${f}</span>`).join('')
      : '<span class="badge b-ok">ok</span>';

    const powerBadge = rec.hasPowerChannels
      ? '<span class="flag flag-power">disponível</span>'
      : '<span class="flag flag-nopower">ausente</span>';

    let altCell;
    if(!dashFiles.length){
      altCell = '<span style="color:var(--dimmer)">— sem log de dashboard</span>';
    } else if(rec.altCoverage===undefined){
      altCell = '<span style="color:var(--dimmer)">calculando…</span>';
    } else if(rec.altCoverage.pct===100){
      altCell = '<span class="badge b-ok">✓ 100%</span>';
    } else if(rec.altCoverage.pct===0){
      altCell = '<span class="badge b-bad">⚠ sem cobertura</span>';
    } else {
      altCell = `<span class="badge b-warn">${fmt(rec.altCoverage.pct,0)}%</span>`;
    }

    tr.innerHTML = `
      <td title="${rec.name}">${rec.name.length>28?rec.name.slice(0,26)+'…':rec.name}</td>
      <td>${rec.sessionLabel}</td>
      <td><input type="text" data-id="${rec.id}" class="tagSelect" list="tagDatalist" value="${rec.tag}" style="width:100px;"></td>
      <td>${rec.N}</td>
      <td>${powerBadge}</td>
      <td>${altCell}</td>
      <td>${qcBadge}</td>
      <td><input type="checkbox" data-id="${rec.id}" class="usePowerChk" ${rec.usePower?'checked':''} ${rec.hasPowerChannels?'':'disabled'}></td>
      <td><button data-id="${rec.id}" class="btn secondary removeBtn" style="padding:4px 10px;font-size:11px;">remover</button></td>
    `;
    body.appendChild(tr);
  });

  document.querySelectorAll('.tagSelect').forEach(sel=>{
    sel.addEventListener('change', e=>{
      const rec = files.find(x=>x.id===e.target.dataset.id);
      rec.tag = e.target.value.trim() || rec.tag;
      ensureTagInOrder(rec.tag);
      renderFileTable(); // atualiza o datalist e a ordem com o novo cluster, se for inédito
    });
  });
  document.querySelectorAll('.usePowerChk').forEach(chk=>{
    chk.addEventListener('change', e=>{
      const rec = files.find(x=>x.id===e.target.dataset.id);
      rec.usePower = e.target.checked;
    });
  });
  document.querySelectorAll('.removeBtn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      files = files.filter(x=>x.id!==e.target.dataset.id);
      renderFileTable();
      document.getElementById('btnProcess').disabled = files.length===0;
    });
  });
}

// ---------- parâmetros (leitura do formulário da seção 02) ----------
// Lê TODOS os campos de parâmetro do DOM e devolve um objeto plano — é a "ponte" entre a UI e
// o resto do projeto: calc.js/data.js nunca leem o DOM diretamente, sempre recebem esse objeto
// já pronto. Chamado toda vez que os parâmetros precisam ser aplicados (processar, calibrar,
// salvar perfil).
function getParams(){
  return {
    mass: parseFloat(document.getElementById('p_mass').value),
    inertiaFactor: parseFloat(document.getElementById('p_inertia').value),
    cda: parseFloat(document.getElementById('p_cda').value),
    crr: parseFloat(document.getElementById('p_crr').value),
    rho: parseFloat(document.getElementById('p_rho').value),
    avgAltitude: parseFloat(document.getElementById('p_altitude').value),
    useGpsAltitude: document.getElementById('p_usegpsalt').checked,
    iatWindowMin: parseFloat(document.getElementById('p_iatwindow').value),
    accelUnit: document.getElementById('p_accelunit').value,
    tireRadius: parseFloat(document.getElementById('p_tire').value),
    diffRatio: parseFloat(document.getElementById('p_diff').value),
    gearRatios: [
      parseFloat(document.getElementById('p_g1').value),
      parseFloat(document.getElementById('p_g2').value),
      parseFloat(document.getElementById('p_g3').value),
      parseFloat(document.getElementById('p_g4').value),
      parseFloat(document.getElementById('p_g5').value),
    ],
    etMaxDelta: parseFloat(document.getElementById('p_etdelta').value),
    etMin: parseFloat(document.getElementById('p_etmin').value),
    etMax: parseFloat(document.getElementById('p_etmax').value),
    etWindow: parseInt(document.getElementById('p_etwindow').value),
    wotThreshold: parseFloat(document.getElementById('p_wot').value),
    loadMin: parseFloat(document.getElementById('p_loadmin').value),
    loadMax: parseFloat(document.getElementById('p_loadmax').value),
    gearFilter: document.getElementById('p_gearfilter').checked,
    gpsFixFilter: document.getElementById('p_gpsfixfilter').checked,
    speedMinKmh: parseFloat(document.getElementById('p_speedmin').value),
    accelMinWot: parseFloat(document.getElementById('p_accelminwot').value),
    accelMinMid: parseFloat(document.getElementById('p_accelminmid').value),
    accelMax: parseFloat(document.getElementById('p_accelmax').value),
    speedJumpMaxKmh: parseFloat(document.getElementById('p_speedjump').value),
    speedJumpWindow: parseInt(document.getElementById('p_speedjumpwindow').value),
    tpMaxDelta: parseFloat(document.getElementById('p_tpjump').value),
    tpJumpWindow: parseInt(document.getElementById('p_tpjumpwindow').value),
    applyGradeCorrection: document.getElementById('p_gradecorrection').checked,
    gradeMinDist: parseFloat(document.getElementById('p_grademinddist').value),
    gradePlausMax: parseFloat(document.getElementById('p_gradeplausmax').value),
    binSize: parseFloat(document.getElementById('p_bin').value),
    lambdaTarget: parseFloat(document.getElementById('p_lambdatarget').value),
    lambdaSrc: document.getElementById('p_lambdasrc').value,
    confHigh: parseInt(document.getElementById('p_confhigh').value),
    confMed: parseInt(document.getElementById('p_confmed').value),
    hideLowConfidenceInCharts: document.getElementById('p_hideLowConf').checked,
    statMethod: document.getElementById('p_statmethod').value,
    trimPct: parseFloat(document.getElementById('p_trimpct').value),
    scoreWeight: parseInt(document.getElementById('p_weight').value)/100,
    shrinkN0: parseFloat(document.getElementById('p_shrink').value),
  };
}
// Atualiza o rótulo "X/Y" ao lado do slider de peso do escore composto, em tempo real.
document.getElementById('p_weight').addEventListener('input', e=>{
  const v = parseInt(e.target.value);
  document.getElementById('wLabel').textContent = v+'/'+(100-v);
});

// Desativa campos de preenchimento manual quando o seletor relacionado torna o valor
// digitado irrelevante — evita a falsa impressão de que editar aquele número muda alguma coisa.
function syncLambdaTargetField(){
  document.getElementById('p_lambdatarget').disabled = (document.getElementById('p_lambdasrc').value === 'log');
}
function syncTrimPctField(){
  document.getElementById('p_trimpct').disabled = (document.getElementById('p_statmethod').value !== 'trimmed');
}
document.getElementById('p_lambdasrc').addEventListener('change', syncLambdaTargetField);
document.getElementById('p_statmethod').addEventListener('change', syncTrimPctField);
syncLambdaTargetField();
syncTrimPctField();

// ---------- salvar/carregar/resetar parâmetros (localStorage do navegador) ----------
const PARAMS_STORAGE_KEY = 'comparador_mapas_injecao_params_v1';

// Todos os elementos de campo de parâmetro (seções 02 e 05), exceto c_tag (que é preenchido
// em runtime a partir dos mapas carregados, não é um parâmetro salvável do usuário).
function getParamFields(){
  return Array.from(document.querySelectorAll('[id^="p_"], [id^="c_"]'))
    .filter(el => el.id !== 'c_tag'); // c_tag é populado em runtime a partir dos arquivos, não é um parâmetro salvável
}

// Salva o valor atual de todos os campos de parâmetro no localStorage, com timestamp.
// Devolve o payload salvo (útil pra mostrar "salvo às HH:MM") ou null se falhar.
function saveParamsToStorage(){
  const data = {};
  getParamFields().forEach(el=>{
    data[el.id] = (el.type==='checkbox') ? el.checked : el.value;
  });
  const payload = { savedAt: new Date().toISOString(), data };
  try{
    localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(payload));
    return payload;
  } catch(e){
    return null;
  }
}

// Aplica um objeto {id: valor} nos campos correspondentes do DOM — usado tanto por
// "Carregar" quanto pelo carregamento automático ao abrir a página.
function applyParamsData(data){
  getParamFields().forEach(el=>{
    if(!(el.id in data)) return;
    if(el.type==='checkbox') el.checked = !!data[el.id];
    else el.value = data[el.id];
  });
  // Reaplica os efeitos colaterais dos campos que controlam outros (desabilitar, labels, etc.)
  syncLambdaTargetField();
  syncTrimPctField();
  const wv = parseInt(document.getElementById('p_weight').value);
  document.getElementById('wLabel').textContent = wv+'/'+(100-wv);
  updateComboEstimate();
}

// Lê o perfil salvo do localStorage e aplica nos campos. Devolve o payload (com savedAt) ou
// null se não houver nada salvo ou o dado estiver corrompido.
function loadParamsFromStorage(){
  let raw;
  try{ raw = localStorage.getItem(PARAMS_STORAGE_KEY); } catch(e){ return null; }
  if(!raw) return null;
  try{
    const payload = JSON.parse(raw);
    applyParamsData(payload.data);
    return payload;
  } catch(e){ return null; }
}

// Restaura todos os campos ao valor ORIGINAL desta versão da ferramenta (não ao último salvo)
// — lê .defaultValue/.defaultChecked/option.defaultSelected, que refletem o atributo do HTML,
// não o que foi alterado em runtime. Por isso funciona mesmo depois de Salvar/Carregar por cima.
function resetParamsToDefault(){
  getParamFields().forEach(el=>{
    if(el.tagName==='SELECT'){
      const def = Array.from(el.options).find(o=>o.defaultSelected);
      if(def) el.value = def.value;
    } else if(el.type==='checkbox'){
      el.checked = el.defaultChecked;
    } else {
      el.value = el.defaultValue;
    }
  });
  syncLambdaTargetField();
  syncTrimPctField();
  const wv = parseInt(document.getElementById('p_weight').value);
  document.getElementById('wLabel').textContent = wv+'/'+(100-wv);
  updateComboEstimate();
}

// Os três botões da seção 06 — cada um só chama a função já comentada acima e mostra o
// resultado na mensagem de status.
document.getElementById('btnSaveParams').addEventListener('click', ()=>{
  const payload = saveParamsToStorage();
  const el = document.getElementById('paramsStorageStatus');
  el.textContent = payload ? `salvo às ${fmtSavedAt(payload.savedAt)}` : 'não foi possível salvar (armazenamento local bloqueado pelo navegador?)';
});
document.getElementById('btnLoadParams').addEventListener('click', ()=>{
  const payload = loadParamsFromStorage();
  const el = document.getElementById('paramsStorageStatus');
  el.textContent = payload ? `carregado (salvo às ${fmtSavedAt(payload.savedAt)})` : 'nenhum perfil salvo encontrado neste navegador';
});
document.getElementById('btnResetParams').addEventListener('click', ()=>{
  resetParamsToDefault();
  document.getElementById('paramsStorageStatus').textContent = 'parâmetros restaurados ao padrão da ferramenta';
});

// auto-carrega ao abrir a página, se houver perfil salvo
(function autoLoadParamsOnStartup(){
  const payload = loadParamsFromStorage();
  if(payload){
    document.getElementById('paramsStorageStatus').textContent = `perfil salvo aplicado automaticamente (salvo às ${fmtSavedAt(payload.savedAt)})`;
  }
})();

// ---------- salvar/carregar/apagar mapas já calculados (localStorage) ----------
const MAPS_STORAGE_KEY = 'comparador_mapas_injecao_saved_maps_v3';
// Chaves de versões anteriores, incompatíveis com o formato atual — mantenha essa lista
// atualizada a cada vez que MAPS_STORAGE_KEY subir de versão, incluindo a chave que acabou
// de ser aposentada. A limpeza roda sozinha no carregamento da página (ver
// cleanupDeprecatedStorage), sem precisar de ação manual do usuário.
const DEPRECATED_STORAGE_KEYS = [
  'comparador_mapas_injecao_saved_maps_v1',
  'comparador_mapas_injecao_saved_maps_v2',
];

// Empacota todos os mapas atualmente processados (WOT + carga parcial) em binário compacto
// (packSamplesBinary, calc.js) e grava como uma nova sessão salva no localStorage, com nome
// dado pelo usuário. Exige nome preenchido e pelo menos um mapa já processado.
function saveCurrentMapsSnapshot(){
  const nameInput = document.getElementById('mapSnapshotName');
  const name = nameInput.value.trim();
  const statusEl = document.getElementById('mapSnapshotStatus');
  if(!name){ statusEl.textContent = 'dê um nome pra sessão antes de salvar'; return; }
  if(!aggregated || !aggregated.tags.length){ statusEl.textContent = 'processe algum log primeiro (seção 03) antes de salvar'; return; }

  const wotPacked = {}, midPacked = {};
  aggregated.tags.forEach(t=>{ wotPacked[t] = packSamplesBinary(aggregated.byTag[t] || []); });
  if(aggregatedMid){ aggregated.tags.forEach(t=>{ midPacked[t] = packSamplesBinary(aggregatedMid.byTag[t] || []); }); }

  const entry = {
    id: 'snap'+Date.now(),
    name, savedAt: new Date().toISOString(),
    tags: aggregated.tags.slice(),
    wotPacked, midPacked,
    paramsSnapshot: aggregated._params
  };
  const sizeBytes = new Blob([JSON.stringify(entry)]).size;
  entry.sizeBytes = sizeBytes;

  const list = loadSavedMapsList();
  list.push(entry);
  const ok = writeSavedMapsList(list);
  if(!ok){
    statusEl.textContent = 'não foi possível salvar — armazenamento local cheio ou bloqueado. Tente apagar sessões salvas antigas.';
    return;
  }
  statusEl.textContent = `salvo: "${name}" (${fmtBytes(sizeBytes)}, ${entry.tags.length} mapa(s))`;
  nameInput.value = '';
  renderSavedMapsTable();
}

// Carrega uma sessão salva e mescla com o que já está processado na tela — nunca substitui.
// Cada mapa da sessão salva entra com o nome entre colchetes (ex.: "base [antes_troca]"), pra
// nunca colidir com um mapa de mesmo nome já processado ao vivo. Cria aggregated/aggregatedMid
// vazios se a página ainda não tiver processado nada (dá pra carregar sessão salva sem nenhum
// CSV carregado).
function mergeSnapshotIntoCurrent(id){
  const list = loadSavedMapsList();
  const entry = list.find(e=>e.id===id);
  if(!entry) return;

  if(!aggregated){
    aggregated = {tags:[], bins:[], byTag:{}, stat:{}, _params: getParams(), _fileResults: []};
  }
  if(!aggregatedMid){
    aggregatedMid = {tags:[], bins:[], byTag:{}, stat:{}, _params: aggregated._params, _fileResults: []};
  }

  // Desempacota o binário recalculando rpi/aep/bin/pHP/torqueNm com os parâmetros ATUAIS
  // (não os de quando a sessão foi salva) — inclusive o bin, então isso já resolve o
  // desalinhamento de grade se o tamanho de bin mudou desde então.
  entry.tags.forEach(tag=>{
    const newTag = `${tag} [${entry.name}]`;
    ensureTagInOrder(newTag);

    const wotSamples = unpackSamplesBinary(entry.wotPacked[tag], aggregated._params);
    aggregated.byTag[newTag] = wotSamples;
    if(!aggregated.tags.includes(newTag)) aggregated.tags.push(newTag);
    wotSamples.forEach(s=>{ if(!aggregated.bins.includes(s.bin)) aggregated.bins.push(s.bin); });

    const midSamples = unpackSamplesBinary(entry.midPacked[tag], aggregatedMid._params);
    aggregatedMid.byTag[newTag] = midSamples;
    if(!aggregatedMid.tags.includes(newTag)) aggregatedMid.tags.push(newTag);
    midSamples.forEach(s=>{ if(!aggregatedMid.bins.includes(s.bin)) aggregatedMid.bins.push(s.bin); });
  });
  aggregated.bins.sort((a,b)=>a-b);
  aggregatedMid.bins.sort((a,b)=>a-b);
  applyTagOrder(aggregated);
  applyTagOrder(aggregatedMid);

  aggregated.stat = computeStatFromByTag(aggregated.byTag, aggregated.tags, aggregated.bins, aggregated._params);
  aggregatedMid.stat = computeStatFromByTag(aggregatedMid.byTag, aggregatedMid.tags, aggregatedMid.bins, aggregatedMid._params);

  document.getElementById('resultsSection').style.display='block';
  document.getElementById('midloadSection').style.display='block';
  document.getElementById('calibSection').style.display='block';
  populateCalibTagSelect();
  renderResults();
  renderMidResults();

  // Aviso informativo: agora quase tudo é recalculado com os parâmetros de hoje (inclusive
  // Cx·A/inércia/densidade), então não há mais "valor congelado" — só o λ_target por amostra
  // não é recuperável quando a fonte original era "canal do log" (não foi salvo por amostra).
  document.getElementById('mapSnapshotStatus').innerHTML =
    `mesclado: "${entry.name}" (${entry.tags.length} mapa(s) adicionados como [${entry.name}]) — recalculado com os parâmetros atuais (Cx·A, inércia, bin, correção de rampa etc.), preservando o λ_target por amostra do log original.`;
}

// Remove uma sessão salva do localStorage (pede confirmação antes, ver botão na tabela).
function deleteSavedMap(id){
  const list = loadSavedMapsList().filter(e=>e.id!==id);
  writeSavedMapsList(list);
  renderSavedMapsTable();
}

// Desenha a tabela de sessões salvas (nome, data, mapas incluídos, tamanho) com botões de
// Carregar/Apagar por linha, e o total de espaço usado no localStorage.
function renderSavedMapsTable(){
  const list = loadSavedMapsList();
  const table = document.getElementById('savedMapsTable');
  const empty = document.getElementById('noSavedMaps');
  const totalEl = document.getElementById('savedMapsTotalSize');
  if(!list.length){
    table.style.display='none'; empty.style.display='block'; totalEl.textContent=''; return;
  }
  table.style.display='table'; empty.style.display='none';
  let h = '<thead><tr><th>Sessão</th><th>Salvo em</th><th>Mapas</th><th>Tamanho</th><th></th></tr></thead><tbody>';
  list.forEach(e=>{
    h += `<tr><td>${e.name}</td><td>${fmtSavedAt(e.savedAt)}</td><td>${e.tags.join(', ')}</td><td>${fmtBytes(e.sizeBytes||0)}</td>
      <td>
        <button class="btn secondary loadMapBtn" data-id="${e.id}" style="padding:4px 10px;font-size:11px;">Carregar</button>
        <button class="btn secondary deleteMapBtn" data-id="${e.id}" style="padding:4px 10px;font-size:11px;">Apagar</button>
      </td></tr>`;
  });
  h += '</tbody>';
  table.innerHTML = h;
  const total = list.reduce((a,e)=>a+(e.sizeBytes||0), 0);
  totalEl.textContent = `${list.length} sessão(ões) salva(s), ${fmtBytes(total)} no total (localStorage costuma ter ~5-10MB de limite por navegador, dividido com o perfil de parâmetros)`;

  table.querySelectorAll('.loadMapBtn').forEach(btn=>{
    btn.addEventListener('click', e=>mergeSnapshotIntoCurrent(e.target.dataset.id));
  });
  table.querySelectorAll('.deleteMapBtn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      if(confirm('Apagar esta sessão salva? Não dá pra desfazer.')) deleteSavedMap(e.target.dataset.id);
    });
  });
}

document.getElementById('btnSaveMaps').addEventListener('click', saveCurrentMapsSnapshot);

// Limpa versões antigas e incompatíveis de armazenamento assim que a página carrega, antes de
// desenhar a tabela — assim o espaço já vem liberado e a mensagem aparece na primeira leitura,
// não só depois de alguma ação do usuário.
(function cleanupOnStartup(){
  const {removedKeys, freedBytes} = cleanupDeprecatedStorage();
  if(removedKeys.length){
    document.getElementById('mapSnapshotStatus').textContent =
      `dados de versão(ões) anterior(es) e incompatível(eis) apagados automaticamente (${fmtBytes(freedBytes)} liberados) — formatos antigos de armazenamento não são lidos por esta versão da ferramenta.`;
  }
})();

renderSavedMapsTable();

// ---------- botão processar ----------
// Lê os parâmetros atuais, reconstrói a timeline de altitude (se houver dashboard), roda
// processFile em cada arquivo de ECU habilitado, e agrega tudo (WOT + carga parcial) em
// aggregated/aggregatedMid — substituindo qualquer resultado anterior (mapas mesclados de
// sessões salvas se perdem aqui; recarregue-os de novo depois de processar, se precisar).
document.getElementById('btnProcess').addEventListener('click', ()=>{
  if(!files.length) return;
  document.getElementById('statusMsg').textContent = 'processando…';
  setTimeout(()=>{ // let UI paint
    const params = getParams();
    const dashTimeline = buildDashAltitudeTimeline();
    const fileResults = files.map(rec=>processFile(rec, params, dashTimeline));
    aggregated = aggregate(fileResults, params, 'samples');
    aggregated._fileResults = fileResults;
    aggregated._params = params;
    aggregatedMid = aggregate(fileResults, params, 'samplesPartial');
    aggregatedMid._fileResults = fileResults;
    aggregatedMid._params = params;
    currentTagsInOrder();
    applyTagOrder(aggregated);
    applyTagOrder(aggregatedMid);
    renderResults();
    renderMidResults();
    document.getElementById('resultsSection').style.display='block';
    document.getElementById('midloadSection').style.display='block';
    document.getElementById('calibSection').style.display='block';
    populateCalibTagSelect();
    document.getElementById('statusMsg').textContent = 'concluído';
  }, 30);
});

// Limpa todo o estado (arquivos, dashboards, resultados) e volta a tela ao estado inicial —
// não afeta nada salvo no localStorage (perfis de parâmetro e mapas salvos continuam lá).
document.getElementById('btnReset').addEventListener('click', ()=>{
  files = []; dashFiles = []; aggregated = null; aggregatedMid = null; tagOrder = [];
  renderFileTable();
  renderDashFileTable();
  document.getElementById('resultsSection').style.display='none';
  document.getElementById('midloadSection').style.display='none';
  document.getElementById('calibSection').style.display='none';
  document.getElementById('btnProcess').disabled = true;
  document.getElementById('statusMsg').textContent = '';
});

// ---------- seções de parâmetros recolhíveis ----------
// Envolve tudo depois do <h3> de cada .subgrp num wrapper, pra poder esconder/mostrar sem
// precisar reescrever o HTML de cada bloco à mão. Começa tudo recolhido — abre só o que o
// usuário clicar.
document.querySelectorAll('.subgrp').forEach(grp=>{
  const h3 = grp.querySelector('h3');
  if(!h3) return;
  const body = document.createElement('div');
  body.className = 'subgrp-body';
  const rest = Array.from(grp.children).filter(el=>el!==h3);
  rest.forEach(el=>body.appendChild(el));
  grp.appendChild(body);
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '▾';
  h3.appendChild(chevron);
  grp.classList.add('collapsed');
  h3.addEventListener('click', ()=>grp.classList.toggle('collapsed'));
});

// ---------- tabs (escopados por grupo, para suportar múltiplos blocos de abas na página) ----------
document.querySelectorAll('.tabs').forEach(tabGroup=>{
  const tabs = Array.from(tabGroup.querySelectorAll('.tab'));
  const scope = tabGroup.parentElement; // .card que contém esse grupo de abas + seus painéis
  tabs.forEach(tab=>{
    tab.addEventListener('click', ()=>{
      tabs.forEach(t=>t.classList.remove('active'));
      scope.querySelectorAll(':scope > .tabpanel').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById('tab-'+tab.dataset.tab);
      if(panel) panel.classList.add('active');
    });
  });
});

// ---------- rendering ----------
const charts = {}; // chave: 'Score'/'Power' + sufixo ('' para WOT, 'Mid' para carga média)

// Redesenha as 4 abas da seção WOT (escore, potência, lambda, QC) a partir de `aggregated`.
// Chamada depois de processar, depois de mesclar sessão salva, e pelo filtro de marcha.
function renderResults(){
  renderGearFilterRow('gearFilterWot', aggregated, ()=>{
    renderScoreTab(aggregated, '');
    renderPowerTab(aggregated, '');
    renderLambdaTab(aggregated, '');
  });
  renderScoreTab(aggregated, '');
  renderPowerTab(aggregated, '');
  renderLambdaTab(aggregated, '');
  renderQCTab(aggregated._fileResults);
}

// Mesma ideia de renderResults, mas pra seção de carga parcial (sem aba de QC — QC é por
// arquivo, já mostrado na seção WOT). refAgg (aggregated) é passado pro renderPowerTab pra
// permitir o alerta cruzado "potência parcial > potência WOT no mesmo bin".
function renderMidResults(){
  renderGearFilterRow('gearFilterMid', aggregatedMid, ()=>{
    renderScoreTab(aggregatedMid, 'Mid');
    renderPowerTab(aggregatedMid, 'Mid', aggregated);
    renderLambdaTab(aggregatedMid, 'Mid');
  });
  renderScoreTab(aggregatedMid, 'Mid');
  renderPowerTab(aggregatedMid, 'Mid', aggregated);
  renderLambdaTab(aggregatedMid, 'Mid');
}

// Monta a faixa de checkboxes de marcha acima dos gráficos de uma seção (WOT ou carga média).
// A 1ª marcha vem desabilitada e desmarcada se o filtro de ruído "excluir 1ª marcha" (seção 02)
// estiver ligado — não faz sentido oferecer um filtro pra marcha que já foi descartada na
// origem, não teria amostra nenhuma pra mostrar.
function renderGearFilterRow(containerId, agg, onChange){
  const container = document.getElementById(containerId);
  if(!container || !agg) return;
  const firstGearBlocked = document.getElementById('p_gearfilter').checked;

  const prevState = {};
  container.querySelectorAll('input[type=checkbox]').forEach(cb=>{ prevState[cb.dataset.gear] = cb.checked; });

  let html = '<span class="gf-label">Marchas</span>';
  for(let g=1; g<=5; g++){
    const disabled = (g===1 && firstGearBlocked);
    const checked = disabled ? false : (prevState.hasOwnProperty(String(g)) ? prevState[String(g)] : true);
    html += `<label title="${disabled?'1ª marcha já excluída pelo filtro de ruído (seção 02)':''}"><input type="checkbox" data-gear="${g}" ${checked?'checked':''} ${disabled?'disabled':''}><span>${g}ª</span></label>`;
  }
  container.innerHTML = html;

  function currentSelection(){
    const sel = new Set();
    container.querySelectorAll('input[type=checkbox]').forEach(cb=>{ if(cb.checked) sel.add(parseInt(cb.dataset.gear,10)); });
    return sel;
  }

  container.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      applyGearFilterToAgg(agg, currentSelection());
      onChange();
    });
  });

  applyGearFilterToAgg(agg, currentSelection());
}

// Aba "Escore composto": gráfico de linha (uma por mapa) + tabela com célula do mapa líder
// destacada por bin, tooltip com RPI/AEP bruto e contraído, e aviso ⚠ quando o mapa com melhor
// potência MEDIDA não é o líder de escore (RPI/AEP é só um proxy de eficiência, pode divergir
// da potência real medida — o aviso existe pra não descartar um mapa bom só pelo escore).
function renderScoreTab(agg, suffix){
  const {tags, bins, stat} = agg;
  const hideLow = agg._params.hideLowConfidenceInCharts;
  const ctxS = document.getElementById('chartScore'+suffix).getContext('2d');
  if(charts['Score'+suffix]) charts['Score'+suffix].destroy();
  charts['Score'+suffix] = new Chart(ctxS, {
    type:'line',
    data:{
      labels: bins.map(b=>b+'–'+(b+agg._params.binSize)),
      datasets: tags.map(t=>({
        label:t,
        data: bins.map(b=>(hideLow && stat[t][b].confidence==='Baixa') ? null : stat[t][b].score),
        borderColor: colorForTag(t),
        backgroundColor:'transparent',
        spanGaps: !hideLow, tension:.25, pointRadius:3,
      }))
    },
    options:{ responsive:true, maintainAspectRatio:false,
      scales:{ y:{ ticks:{color:'#8b96a5'}, grid:{color:'#242933'} }, x:{ ticks:{color:'#8b96a5'}, grid:{color:'#1f242c'} } },
      plugins:{ legend:{ labels:{color:'#e6eaf0'} } }
    }
  });

  let hScore = '<thead><tr><th>Bin RPM</th>'+tags.map(t=>`<th style="color:${colorForTag(t)}">${t}</th>`).join('')+'</tr></thead><tbody>';
  bins.forEach(b=>{
    const bestPow = bestPowerTagInBin(stat, tags, b);
    // Se "ocultar baixa confiança" está ligado, o líder do bin considera só quem está de fato
    // plotado no gráfico — um bin de confiança Baixa não deve roubar o destaque de um valor
    // que nem aparece na linha.
    let leader=null, leaderVal=-Infinity;
    tags.forEach(t=>{
      const sv=stat[t][b].score;
      if(hideLow && stat[t][b].confidence==='Baixa') return;
      if(!isNaN(sv) && sv>leaderVal){ leaderVal=sv; leader=t; }
    });
    hScore += `<tr><td>${b}</td>`+ tags.map(t=>{
      const s = stat[t][b];
      const conf = s.confidence==='Alta'?'b-ok':(s.confidence==='Média'?'b-warn':'b-bad');
      const title = `RPI bruto=${fmt(s.rpi,4)} contraído=${fmt(s.rpiShrunk,4)} · AEP bruto=${fmt(s.aep,4)} contraído=${fmt(s.aepShrunk,4)}`;
      const warn = (t===bestPow && !isNaN(s.score) && s.score<0.35)
        ? ` <span class="warn-icon" title="Este mapa tem a melhor potência medida (confiança ≥ Média) neste bin, mas o proxy RPI/AEP penalizou o escore — não descarte só pelo escore.">⚠</span>`
        : '';
      const excluded = hideLow && s.confidence==='Baixa';
      const cls = (t===leader && !isNaN(s.score)) ? ' class="leader-cell"' : (excluded ? ' class="cell-excluded"' : '');
      const excludedTitle = excluded ? ' title="Confiança Baixa — oculto na linha do gráfico, mostrado aqui só para referência"' : '';
      return `<td${cls}${excludedTitle || ` title="${title}"`}>${fmt(s.score,3)} <span class="badge ${conf}">n=${s.n}</span>${warn}</td>`;
    }).join('') + '</tr>';
  });
  hScore += '</tbody>';
  document.getElementById('tableScore'+suffix).innerHTML = hScore;
  const legendEl = document.getElementById('scoreLegend'+suffix);
  if(legendEl) legendEl.innerHTML = `<span class="leader-swatch"></span>fundo destacado = mapa líder (melhor escore) no bin &nbsp;·&nbsp; <span class="warn-icon">⚠</span> = este mapa tem a melhor potência medida (confiança ≥ Média) no bin, mas o proxy RPI/AEP penalizou o escore — não descarte só pelo escore${hideLow ? ' &nbsp;·&nbsp; célula esmaecida = confiança Baixa, oculta na linha do gráfico' : ''}`;
}

// Aba "Potência estimada": gráfico de linha + tabela wHP/N·m por bin. Canvas some/aparece
// (nunca é removido do DOM — ver nota abaixo) conforme há ou não amostra de potência utilizável
// pra marchas/mapas selecionados no momento. refAgg (quando presente, no caso de carga parcial)
// habilita o alerta cruzado: potência parcial > WOT no mesmo bin é fisicamente improvável e
// quase sempre indica contaminação por rampa ou transição não filtrada.
function renderPowerTab(agg, suffix, refAgg){
  const {tags, bins, stat} = agg;
  const hideLow = agg._params.hideLowConfidenceInCharts;
  const canvas = document.getElementById('chartPower'+suffix);
  const anyPower = tags.some(t=>bins.some(b=>!isNaN(stat[t][b].pHP)));

  // Mensagem de "sem dado" como irmã do canvas, criada uma vez e reaproveitada — nunca remove
  // o <canvas> do DOM (removê-lo quebrava a próxima renderização, já que getElementById não
  // achava mais o elemento depois).
  let emptyMsg = document.getElementById('chartPower'+suffix+'Empty');
  if(!emptyMsg){
    emptyMsg = document.createElement('div');
    emptyMsg.id = 'chartPower'+suffix+'Empty';
    emptyMsg.className = 'empty';
    emptyMsg.textContent = 'Nenhum arquivo habilitado tem canais de potência utilizáveis nesta faixa (ou nenhuma marcha selecionada acima).';
    emptyMsg.style.display = 'none';
    canvas.parentElement.appendChild(emptyMsg);
  }

  if(anyPower){
    canvas.style.display = '';
    emptyMsg.style.display = 'none';
    const ctxP = canvas.getContext('2d');
    if(charts['Power'+suffix]) charts['Power'+suffix].destroy();
    charts['Power'+suffix] = new Chart(ctxP, {
      type:'line',
      data:{
        labels: bins.map(b=>b+'–'+(b+agg._params.binSize)),
        datasets: tags.map(t=>({
          label:t,
          data: bins.map(b=>(hideLow && stat[t][b].confidencePower==='Baixa') ? null : stat[t][b].pHP),
          borderColor: colorForTag(t),
          backgroundColor:'transparent',
          spanGaps: !hideLow, tension:.25, pointRadius:3,
        }))
      },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{ y:{ title:{display:true,text:'wHP estimado',color:'#8b96a5'}, ticks:{color:'#8b96a5'}, grid:{color:'#242933'} },
                 x:{ ticks:{color:'#8b96a5'}, grid:{color:'#1f242c'} } },
        plugins:{ legend:{ labels:{color:'#e6eaf0'} } }
      }
    });
  } else {
    if(charts['Power'+suffix]){ charts['Power'+suffix].destroy(); charts['Power'+suffix]=null; }
    canvas.style.display = 'none';
    emptyMsg.style.display = '';
  }

  let hPow = '<thead><tr><th>Bin RPM</th>'+tags.map(t=>`<th style="color:${colorForTag(t)}">${t}</th>`).join('')+'</tr></thead><tbody>';
  bins.forEach(b=>{
    // Mesma regra do escore: se "ocultar baixa confiança" está ligado, o líder do bin não
    // considera quem está de fora da linha do gráfico.
    let leader=null, leaderVal=-Infinity;
    tags.forEach(t=>{
      const s=stat[t][b];
      if(hideLow && s.confidencePower==='Baixa') return;
      if(s.nPower>0 && s.pHP>leaderVal){ leaderVal=s.pHP; leader=t; }
    });
    hPow += `<tr><td>${b}</td>`+ tags.map(t=>{
      const s = stat[t][b];
      if(s.nPower===0) return '<td>—</td>';
      const conf = s.confidencePower==='Alta'?'b-ok':(s.confidencePower==='Média'?'b-warn':'b-bad');
      const excluded = hideLow && s.confidencePower==='Baixa';
      const cls = (t===leader) ? ' class="leader-cell"' : (excluded ? ' class="cell-excluded"' : '');
      const excludedTitle = excluded ? ' title="Confiança Baixa — oculto na linha do gráfico, mostrado aqui só para referência"' : '';
      let warn = '';
      if(refAgg){
        const ref = refAgg.stat[t] && refAgg.stat[t][b];
        if(ref && ref.nPower>0 && s.pHP > ref.pHP){
          const gradeNote = !isNaN(s.grade) ? ` Rampa medida (dashboard) nesse trecho: ${fmt(s.grade,1)}% (${s.grade<0?'descida':'subida'}).` : ' Sem cobertura de dashboard/altitude para confirmar rampa nesse trecho.';
          warn = ` <span class="warn-icon" title="Potência em carga parcial (${fmt(s.pHP,1)} wHP) maior que em WOT (${fmt(ref.pHP,1)} wHP) neste bin — fisicamente improvável para motor aspirado.${gradeNote} Provável contaminação por inclinação de pista ou transição não filtrada, não um resultado real. Trate com desconfiança.">⚠</span>`;
        }
      }
      return `<td${cls}${excludedTitle}>${fmt(s.pHP,1)} wHP / ${fmt(s.torqueNm,1)} N·m <span class="badge ${conf}">n=${s.nPower}</span>${warn}</td>`;
    }).join('') + '</tr>';
  });
  hPow += '</tbody>';
  document.getElementById('tablePower'+suffix).innerHTML = hPow;
  const legendEl = document.getElementById('powerLegend'+suffix);
  if(legendEl){
    const excludedNote = hideLow ? ' &nbsp;·&nbsp; célula esmaecida = confiança Baixa, oculta na linha do gráfico' : '';
    legendEl.innerHTML = refAgg
      ? `<span class="leader-swatch"></span>fundo destacado = mapa líder (maior potência estimada) no bin &nbsp;·&nbsp; <span class="warn-icon">⚠</span> = potência em carga parcial maior que em WOT no mesmo bin — fisicamente improvável, provável contaminação de inclinação de pista ou transição não filtrada, não confie neste número sem investigar${excludedNote}`
      : `<span class="leader-swatch"></span>fundo destacado = mapa líder (maior potência estimada) no bin${excludedNote}`;
  }
}

// Aba "Lambda & trim": tabela resumo por mapa (média de lambda, trims de combustível e
// injection timing, sem separar por bin de rpm — visão geral da calibração de mistura).
function renderLambdaTab(agg, suffix){
  const {tags, bins} = agg;
  let hLam = '<thead><tr><th>Mapa</th><th>λ médio</th><th>Global Fuel Trim médio</th><th>Fuel Comp Total médio</th><th>Injection Timing médio</th><th>Amostras</th></tr></thead><tbody>';
  tags.forEach(t=>{
    const all = bins.flatMap(b=>agg.byTag[t].filter(s=>s.bin===b));
    hLam += `<tr><td style="color:${colorForTag(t)}">${t}</td>
      <td>${fmt(mean(all.map(s=>s.lambda)),3)}</td>
      <td>${fmt(mean(all.map(s=>s.gft)),2)}</td>
      <td>${fmt(mean(all.map(s=>s.fct)),2)}</td>
      <td>${fmt(mean(all.map(s=>s.inj)),1)}</td>
      <td>${all.length}</td></tr>`;
  });
  hLam += '</tbody>';
  document.getElementById('tableLambda'+suffix).innerHTML = hLam;
}

// Aba "QC por arquivo": uma linha por arquivo de ECU processado, com contagem de exclusões,
// pressão pré-partida detectada (e altitude implícita), cobertura de rampa/altitude, status
// de habilitação de potência, e os alertas de qualidade (runQC, data.js) daquele arquivo.
function renderQCTab(fileResults){
  let hQC = '<thead><tr><th>Arquivo</th><th>Mapa</th><th>Linhas</th><th>Excluídas p/ ET</th><th>Amostras WOT</th><th>Amostras carga média</th><th>Pressão pré-partida</th><th>Altitude (elegíveis)</th><th>Potência</th><th>Alertas</th></tr></thead><tbody>';
  fileResults.forEach(fr=>{
    const powerStatus = fr.hasPowerChannels
      ? (fr.usePower ? '<span class="badge b-ok">habilitada</span>' : '<span class="badge b-warn">desabilitada</span>')
      : '<span class="badge b-bad">sem canais</span>';
    const baro = !isNaN(fr.preCrankBaroKPa)
      ? `${fmt(fr.preCrankBaroKPa,1)} kPa <span class="sub">(≈${fmt(altitudeFromPressureKPa(fr.preCrankBaroKPa),0)}m)</span>`
      : '<span class="badge b-warn">não detectada</span>';
    const gc = fr.gradeCoverage;
    const gcPct = gc.total ? 100*gc.n/gc.total : 0;
    const gcCls = gc.total===0 ? '' : (gc.n===0 ? 'b-bad' : (gc.n===gc.total ? 'b-ok' : 'b-warn'));
    const altCoverage = gc.total===0 ? '<span style="color:var(--dimmer)">—</span>'
      : `<span class="badge ${gcCls}">${gc.n}/${gc.total} (${fmt(gcPct,0)}%)</span>`;
    hQC += `<tr><td>${fr.fileName}</td><td style="color:${colorForTag(fr.tag)}">${fr.tag}</td>
      <td>${fr.N}</td><td>${fr.etExcludedCount} (${fmt(100*fr.etExcludedCount/fr.N,1)}%)</td>
      <td>${fr.wotCount}</td><td>${fr.loadCount}</td><td>${baro}</td><td>${altCoverage}</td><td>${powerStatus}</td>
      <td>${fr.qc.flags.length? fr.qc.flags.join('; '):'—'}</td></tr>`;
  });
  hQC += '</tbody>';
  document.getElementById('tableQC').innerHTML = hQC;
}

// ---------- exportação ----------
// Exporta a tabela de estatística completa (todos os bins x todos os mapas, WOT + carga
// parcial) em CSV plano — uma linha por combinação bin/mapa/regime.
document.getElementById('btnExportCsv').addEventListener('click', ()=>{
  if(!aggregated) return;
  const header = 'regime,bin_rpm,mapa,n,escore,rpi_bruto,rpi_contraido,aep_bruto,aep_contraido,n_power,potencia_whp,torque_nm,lambda_medio,gft_medio,fct_medio,inj_medio,rampa_pct,confianca,confianca_potencia\n';
  function dump(agg, regime){
    const {tags, bins, stat} = agg;
    let out = '';
    bins.forEach(b=>{
      tags.forEach(t=>{
        const s = stat[t][b];
        out += [regime, b, t, s.n, s.score, s.rpi, s.rpiShrunk, s.aep, s.aepShrunk, s.nPower, s.pHP, s.torqueNm, s.lambda, s.gft, s.fct, s.inj, s.grade, s.confidence, s.confidencePower]
          .map(v=>v===undefined||v===null||(typeof v==='number'&&isNaN(v))?'':v).join(',')+'\n';
      });
    });
    return out;
  }
  let csv = header + dump(aggregated, 'wot');
  if(aggregatedMid) csv += dump(aggregatedMid, 'carga_media');
  downloadText(csv, 'comparativo_mapas_injecao.csv', 'text/csv');
});

// Exporta os parâmetros usados, o resumo por arquivo, e a tabela de estatística completa em
// JSON estruturado — mais fácil de reprocessar programaticamente que o CSV (ex.: num notebook).
document.getElementById('btnExportJson').addEventListener('click', ()=>{
  if(!aggregated) return;
  const payload = {
    params: aggregated._params,
    fileResults: aggregated._fileResults.map(fr=>({
      fileName:fr.fileName, tag:fr.tag, N:fr.N, wotCount:fr.wotCount, loadCount:fr.loadCount,
      etExcludedCount:fr.etExcludedCount, hasPowerChannels:fr.hasPowerChannels,
      usePower:fr.usePower, qc:fr.qc
    })),
    wot: { bins: aggregated.bins, stat: aggregated.stat },
    cargaMedia: aggregatedMid ? { bins: aggregatedMid.bins, stat: aggregatedMid.stat } : null
  };
  downloadText(JSON.stringify(payload, null, 2), 'comparativo_mapas_injecao.json', 'application/json');
});

// Dispara o download de um texto como arquivo, via Blob + link temporário (padrão do navegador,
// sem precisar de servidor) — usado pelos dois exports acima.
function downloadText(content, filename, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- calibração (seção 05) ----------
// Popula o seletor de mapa da calibração com os mapas atualmente processados/mesclados.
function populateCalibTagSelect(){
  const sel = document.getElementById('c_tag');
  sel.innerHTML = aggregated.tags.map(t=>`<option value="${t}">${t}</option>`).join('');
}

// Mostra ao vivo quantas combinações de Cx·A × inércia a busca em grade vai testar, conforme
// o usuário ajusta faixa/passo — antes de rodar de verdade, pra dar noção do custo.
function updateComboEstimate(){
  const cdaMin = parseFloat(document.getElementById('c_cda_min').value);
  const cdaMax = parseFloat(document.getElementById('c_cda_max').value);
  const cdaStep = parseFloat(document.getElementById('c_cda_step').value);
  const inMin = parseFloat(document.getElementById('c_in_min').value);
  const inMax = parseFloat(document.getElementById('c_in_max').value);
  const inStep = parseFloat(document.getElementById('c_in_step').value);
  const el = document.getElementById('calibComboEstimate');
  if([cdaMin,cdaMax,cdaStep,inMin,inMax,inStep].some(v=>isNaN(v)||v<=0) || cdaMax<cdaMin || inMax<inMin){
    el.textContent = ''; return;
  }
  const cdaCount = Math.floor((cdaMax-cdaMin)/cdaStep + 1e-9) + 1;
  const inCount = Math.floor((inMax-inMin)/inStep + 1e-9) + 1;
  el.textContent = `${cdaCount} × ${inCount} = ${cdaCount*inCount} combinações a testar`;
}
['c_cda_min','c_cda_max','c_cda_step','c_in_min','c_in_max','c_in_step'].forEach(id=>{
  document.getElementById(id).addEventListener('input', updateComboEstimate);
});
updateComboEstimate();

// Roda a busca em grade de Cx·A × inércia: filtra as amostras elegíveis uma vez
// (getEligibleCalibRows, data.js), depois testa cada combinação da grade contra elas
// (computeCalibPowerFast, calc.js), comparando a potência/torque estimados nos rpm de
// referência do dyno contra os valores medidos — mantém a combinação de menor erro combinado.
// Cede o controle pro navegador a cada ~60ms (requestAnimationFrame) pra não travar a UI numa
// grade grande.
document.getElementById('btnCalibrate').addEventListener('click', async ()=>{
  if(!aggregated){ return; }
  const tag = document.getElementById('c_tag').value;
  const gearWanted = parseInt(document.getElementById('c_gear').value);
  const pDyno = parseFloat(document.getElementById('c_pdyno').value);
  const rpmP = parseFloat(document.getElementById('c_rpmP').value);
  const tDyno = parseFloat(document.getElementById('c_tdyno').value) * 9.80665; // kgf.m -> N.m
  const rpmT = parseFloat(document.getElementById('c_rpmT').value);
  const rpmTol = parseFloat(document.getElementById('c_rpmtol').value);
  const cdaMin = parseFloat(document.getElementById('c_cda_min').value);
  const cdaMax = parseFloat(document.getElementById('c_cda_max').value);
  const cdaStep = parseFloat(document.getElementById('c_cda_step').value);
  const inMin = parseFloat(document.getElementById('c_in_min').value);
  const inMax = parseFloat(document.getElementById('c_in_max').value);
  const inStep = parseFloat(document.getElementById('c_in_step').value);
  const pKpaDyno = parseFloat(document.getElementById('c_pkpa').value);
  const tcDyno = parseFloat(document.getElementById('c_tc').value);
  const rhDyno = parseFloat(document.getElementById('c_rh').value);
  const rhoDyno = airDensityHumid(pKpaDyno, tcDyno, rhDyno);
  const dashTimelineForCalib = buildDashAltitudeTimeline();
  document.getElementById('calibDensityInfo').innerHTML =
    `ρ do ensaio (calculada de ${pKpaDyno} kPa, ${tcDyno}°C, ${rhDyno}% UR): ${rhoDyno.toFixed(4)} kg/m³ — usada na busca abaixo, no lugar da densidade por amostra que o gráfico principal calcula (altitude+IAT). São propositalmente diferentes: aqui queremos a densidade real do dia do dyno; lá, a densidade real de cada sessão. Não espere o mesmo Cx·A/inércia reproduzir exatamente o mesmo wHP nas duas telas — a comparação correta é contra P_dyno_max/T_dyno_max, não contra o gráfico.`;

  const baseParams = getParams();
  baseParams.rho = rhoDyno; // a calibração usa a densidade do dia do ensaio, não a fixa/geral

  const btn = document.getElementById('btnCalibrate');
  btn.disabled = true;
  const progressWrap = document.getElementById('calibProgressWrap');
  const progressBar = document.getElementById('calibProgressBar');
  const progressLabel = document.getElementById('calibProgressLabel');
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressLabel.textContent = 'filtrando amostras…';
  document.getElementById('calibResult').innerHTML = '';
  await new Promise(r=>requestAnimationFrame(r));

  const eligibleRows = getEligibleCalibRows(tag, gearWanted, baseParams, dashTimelineForCalib);

  if(!eligibleRows.length){
    progressWrap.style.display = 'none';
    btn.disabled = false;
    document.getElementById('calibResult').innerHTML = '<span style="color:var(--red)">Nenhuma amostra WOT encontrada na marcha '+gearWanted+' para o mapa "'+tag+'". Verifique se o arquivo tem canal de Marcha confiável nesses trechos.</span>';
    return;
  }

  const cdaCount = Math.floor((cdaMax-cdaMin)/cdaStep + 1e-9) + 1;
  const inCount = Math.floor((inMax-inMin)/inStep + 1e-9) + 1;
  const totalCombos = Math.max(0, cdaCount) * Math.max(0, inCount);

  let best=null;
  const results = [];
  let done = 0;
  let lastYield = performance.now();

  for(let ci=0; ci<cdaCount; ci++){
    const cda = Number((cdaMin + ci*cdaStep).toFixed(4));
    for(let ii=0; ii<inCount; ii++){
      const inertia = Number((inMin + ii*inStep).toFixed(4));
      const recomputed = computeCalibPowerFast(eligibleRows, cda, inertia, baseParams);
      const nearP = recomputed.filter(s=>Math.abs(s.rpm-rpmP)<=rpmTol);
      const nearT = recomputed.filter(s=>Math.abs(s.rpm-rpmT)<=rpmTol);
      const pEst = binStat(nearP.map(s=>s.pHP), baseParams);
      const tEst = binStat(nearT.map(s=>s.torqueNm), baseParams);
      done++;
      if(!isNaN(pEst)){
        const errP = Math.abs(pEst-pDyno)/pDyno;
        const errT = isNaN(tEst) ? null : Math.abs(tEst-tDyno)/tDyno;
        const combinedErr = errT!==null ? (errP+errT)/2 : errP;
        const rec = {cda, inertia, pEst, tEst, errP, errT, combinedErr, nP:nearP.length, nT:nearT.length};
        results.push(rec);
        if(!best || combinedErr < best.combinedErr) best = rec;
      }

      if(performance.now()-lastYield > 60){
        const pct = totalCombos ? (100*done/totalCombos) : 100;
        progressBar.style.width = pct.toFixed(1)+'%';
        progressLabel.textContent = `testando combinações… ${done}/${totalCombos} (${pct.toFixed(0)}%)`;
        lastYield = performance.now();
        await new Promise(r=>requestAnimationFrame(r));
      }
    }
  }

  progressBar.style.width = '100%';
  progressLabel.textContent = `concluído — ${done}/${totalCombos} combinações testadas`;
  setTimeout(()=>{ progressWrap.style.display = 'none'; }, 800);
  btn.disabled = false;

  if(!best){
    document.getElementById('calibResult').innerHTML = '<span style="color:var(--red)">Busca não convergiu — amplie a janela de tolerância de RPM ou verifique os dados de calibração.</span>';
    return;
  }

  window._bestCalib = best;
  document.getElementById('btnApplyCalib').disabled = false;
  document.getElementById('calibResult').innerHTML = `
    Melhor ajuste encontrado (de ${results.length} combinações testadas):<br>
    Cx·A = <span class="hl">${best.cda.toFixed(3)}</span> m² &nbsp;·&nbsp;
    Fator de inércia = <span class="hl">${best.inertia.toFixed(3)}</span><br>
    P_estimado(${rpmP}±${rpmTol} rpm) = <span class="hl">${fmt(best.pEst,2)}</span> wHP
      (referência ${pDyno} wHP, erro ${fmt(best.errP*100,1)}%, n=${best.nP})<br>
    T_estimado(${rpmT}±${rpmTol} rpm) = <span class="hl">${fmt(best.tEst,1)}</span> N·m
      (referência ${fmt(tDyno,1)} N·m / ${(tDyno/9.80665).toFixed(2)} kgf·m, erro ${best.errT!==null?fmt(best.errT*100,1)+'%':'—'}, n=${best.nT})<br>
    ${(best.errP>0.05 || (best.errT!==null && best.errT>0.05)) ?
      '<span style="color:var(--red)">Erro acima de ±5% mesmo no melhor ponto da grade — considere que o erro residual pode estar em outro lugar (ex.: relação de câmbio, marcha do dyno vs. marcha do log, ou canal de Aceleração em unidade errada), não apenas em Cx·A/inércia.</span>' :
      '<span style="color:var(--green)">Dentro da tolerância de ±5%.</span>'}
  `;
});

// Copia o melhor resultado da calibração pros campos de Cx·A/inércia da seção 02 — não
// reprocessa sozinho, o usuário precisa clicar em "Processar logs" de novo pra aplicar de fato.
document.getElementById('btnApplyCalib').addEventListener('click', ()=>{
  const b = window._bestCalib;
  if(!b) return;
  document.getElementById('p_cda').value = b.cda.toFixed(3);
  document.getElementById('p_inertia').value = b.inertia.toFixed(3);
  document.getElementById('statusMsg').textContent = 'parâmetros de calibração aplicados — reprocesse os logs';
});
