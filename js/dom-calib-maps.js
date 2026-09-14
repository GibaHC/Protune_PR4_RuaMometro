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
