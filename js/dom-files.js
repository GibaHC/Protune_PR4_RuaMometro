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
