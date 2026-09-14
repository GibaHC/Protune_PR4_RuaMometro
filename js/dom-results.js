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
