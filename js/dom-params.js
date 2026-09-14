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
  if(typeof updateComboEstimate==='function') updateComboEstimate(); // definida em dom-calib-maps.js — carregado depois; guarda defensiva evita depender da ordem exata de <script>
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
  if(typeof updateComboEstimate==='function') updateComboEstimate(); // definida em dom-calib-maps.js — carregado depois; guarda defensiva evita depender da ordem exata de <script>
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
