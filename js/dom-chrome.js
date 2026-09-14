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
