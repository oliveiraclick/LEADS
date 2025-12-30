
import React, { useState, useEffect, useMemo } from 'react';
import { searchBusinesses, fetchNeighborhoods, generatePitch } from './services/gemini';
import { supabase, saveLeadsToCloud, saveCampaignToCloud, deleteCampaignFromCloud } from './services/supabase';
import { BusinessInfo, Campaign, GroundingSource } from './types';

const CAMPAIGNS_KEY = 'leadpro_campaigns_v3';
const LEADS_KEY = 'leadpro_leads_v3';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'mine' | 'leads' | 'settings'>('home');
  const [selectedLead, setSelectedLead] = useState<BusinessInfo | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [leads, setLeads] = useState<BusinessInfo[]>([]);
  
  const [niche, setNiche] = useState('');
  const [city, setCity] = useState('');
  const [neighborhoodsList, setNeighborhoodsList] = useState<string[]>([]);
  const [selectedNeighborhoods, setSelectedNeighborhoods] = useState<string[]>([]);
  const [loadingNeighborhoods, setLoadingNeighborhoods] = useState(false);
  const [isMining, setIsMining] = useState(false);
  const [miningLog, setMiningLog] = useState<{ new: number, skipped: number } | null>(null);
  const [miningProgress, setMiningProgress] = useState<{ current: number, total: number, active: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<'online' | 'sincronizando' | 'offline'>('online');
  const [lastSources, setLastSources] = useState<GroundingSource[]>([]);

  const normalize = (text: string) => (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

  useEffect(() => {
    const init = async () => {
      let rawCampaigns: Campaign[] = [];
      let rawLeads: BusinessInfo[] = [];
      const savedC = localStorage.getItem(CAMPAIGNS_KEY);
      const savedL = localStorage.getItem(LEADS_KEY);
      if (savedC) rawCampaigns = JSON.parse(savedC);
      if (savedL) rawLeads = JSON.parse(savedL);

      try {
        const { data: cData } = await supabase.from('campaigns').select('*').order('createdAt', { ascending: true });
        const { data: lData } = await supabase.from('leads').select('*');
        if (cData) rawCampaigns = cData;
        if (lData) rawLeads = lData;
        const uniqueLeads = Array.from(new Map(rawLeads.map(l => [`${l.id}_${l.campaignId}`, l])).values());
        setCampaigns(rawCampaigns);
        setLeads(uniqueLeads);
      } catch (e) {
        setCloudStatus('offline');
        setCampaigns(rawCampaigns);
        setLeads(rawLeads);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (campaigns.length > 0 || leads.length > 0) {
      localStorage.setItem(CAMPAIGNS_KEY, JSON.stringify(campaigns));
      localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
    }
  }, [campaigns, leads]);

  const stats = useMemo(() => {
    const neighborhoodMap: Record<string, number> = {};
    leads.forEach(l => { neighborhoodMap[l.neighborhood] = (neighborhoodMap[l.neighborhood] || 0) + 1; });
    return {
      total: leads.length,
      campaigns: campaigns.length,
      byNeighborhood: Object.entries(neighborhoodMap).sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [leads, campaigns]);

  const filteredLeads = useMemo(() => {
    if (!activeCampaignId) return leads;
    return leads.filter(l => l.campaignId === activeCampaignId);
  }, [leads, activeCampaignId]);

  const handleStartMining = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!niche || !city || selectedNeighborhoods.length === 0) return;
    
    setErrorMessage(null);
    setMiningLog({ new: 0, skipped: 0 });
    const normNiche = normalize(niche);
    const normCity = normalize(city);
    
    const existingCampaign = campaigns.find(
      c => normalize(c.niche) === normNiche && normalize(c.city) === normCity
    );

    let targetCampaignId = existingCampaign?.id || crypto.randomUUID();

    if (!existingCampaign) {
      const newCampaign: Campaign = {
        id: targetCampaignId,
        niche: niche.trim().toUpperCase(),
        city: city.trim().toUpperCase(),
        createdAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
      };
      setCampaigns(prev => [newCampaign, ...prev]);
      await saveCampaignToCloud(newCampaign);
    }

    setIsMining(true);
    setCloudStatus('sincronizando');

    let currentLeadsState = [...leads];
    let newCountTotal = 0;
    let skippedCountTotal = 0;
    const allSources: GroundingSource[] = [];

    try {
      for (let i = 0; i < selectedNeighborhoods.length; i++) {
        const barrio = selectedNeighborhoods[i];
        setMiningProgress({ current: i + 1, total: selectedNeighborhoods.length, active: barrio });
        
        try {
          // Pequena pausa antes de cada busca para evitar 429
          await new Promise(r => setTimeout(r, 2000));
          
          const result = await searchBusinesses(niche, city, barrio, true);
          const batchToSave: any[] = [];
          
          if (result.sources) allSources.push(...result.sources);
          
          result.businesses.forEach(biz => {
            const exists = currentLeadsState.some(l => l.id === biz.id && l.campaignId === targetCampaignId);
            if (!exists) {
              const leadData = { ...biz, campaignId: targetCampaignId, lastSeenAt: new Date().toISOString() };
              currentLeadsState.push(leadData);
              batchToSave.push(leadData);
              newCountTotal++;
            } else {
              skippedCountTotal++;
            }
          });
          
          setMiningLog({ new: newCountTotal, skipped: skippedCountTotal });
          if (batchToSave.length > 0) {
            await saveLeadsToCloud(batchToSave);
            setLeads([...currentLeadsState]);
          }
        } catch (err: any) {
          if (err.message?.includes('429')) {
             setErrorMessage("Cota diária do Google atingida. Mineramos até onde foi possível. Tente novamente em 1 hora para pegar o restante dos bairros.");
             break;
          } else {
            setErrorMessage("Ocorreu um erro inesperado. Verifique sua conexão.");
          }
        }
      }
      setLastSources(allSources);
    } finally {
      setIsMining(false);
      setMiningProgress(null);
      setCloudStatus('online');
      if (!errorMessage) {
        setTimeout(() => { setActiveTab('leads'); setMiningLog(null); }, 1500);
      }
    }
  };

  const handleFetchNeighborhoods = async () => {
    if (!city) return;
    setLoadingNeighborhoods(true);
    try {
      const list = await fetchNeighborhoods(city);
      setNeighborhoodsList(list);
    } catch (err: any) {
      if (err.message?.includes('429')) {
        setErrorMessage("Não foi possível carregar bairros (Limite de busca atingido).");
      }
    } finally {
      setLoadingNeighborhoods(false);
    }
  };

  const handleGeneratePitch = async (lead: BusinessInfo) => {
    const updatedLeadWithLoading = { ...lead, notes: "✨ Criando abordagem..." };
    setSelectedLead(updatedLeadWithLoading);
    try {
      const currentNiche = campaigns.find(c => c.id === lead.campaignId)?.niche || 'Negócios';
      const pitch = await generatePitch(currentNiche, lead.name);
      const updatedLead = { ...lead, notes: pitch };
      setSelectedLead(updatedLead);
      setLeads(prev => prev.map(l => l.id === lead.id ? updatedLead : l));
      saveLeadsToCloud([updatedLead]);
    } catch (err) {
      setSelectedLead({ ...lead, notes: "Limite atingido. Tente em breve." });
    }
  };

  // Fixed missing performExport function
  const performExport = (scope: 'current' | 'all', format: 'whatsapp') => {
    const list = scope === 'current' ? filteredLeads : leads;
    if (list.length === 0) return;
    
    if (format === 'whatsapp') {
      const contactText = list.map(l => `${l.name}: ${l.phone}`).join('\n');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(contactText).then(() => {
          alert("Lista copiada para a área de transferência!");
          setShowExportMenu(false);
        });
      } else {
        alert("Clipboard indisponível.");
      }
    }
  };

  return (
    <div className="flex flex-col min-h-screen pb-32">
      <header className="p-6 safe-top flex justify-between items-center sticky top-0 bg-[#0B0F1A]/80 backdrop-blur-lg z-40">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center font-black text-indigo-400">LP</div>
          <div>
            <h1 className="text-sm font-black text-white uppercase">LeadPro Hub</h1>
            <div className="flex items-center space-x-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${cloudStatus === 'online' ? 'bg-green-500' : 'bg-amber-500'}`}></span>
              <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Cloud: {cloudStatus}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="px-6 space-y-8 animate-fadeIn">
        {errorMessage && (
          <div className="p-5 bg-amber-500/10 border border-amber-500/20 rounded-3xl flex items-start space-x-3">
            <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <p className="text-[11px] font-bold text-amber-200 leading-tight">{errorMessage}</p>
          </div>
        )}

        {activeTab === 'home' && (
          <div className="space-y-8">
            <h2 className="text-3xl font-black text-white leading-tight">Olá, <span className="text-indigo-400">Prospector</span></h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="glass-card p-6 rounded-[2.2rem]">
                <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Total Único</p>
                <p className="text-3xl font-black text-white">{stats.total}</p>
                <p className="text-[8px] text-green-500 font-bold uppercase mt-1">Limpo e Validado</p>
              </div>
              <div className="glass-card p-6 rounded-[2.2rem]">
                <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Campanhas</p>
                <p className="text-3xl font-black text-white">{stats.campaigns}</p>
              </div>
            </div>
            <div className="glass-card p-6 rounded-[2.5rem] space-y-4">
              <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest border-b border-white/5 pb-3">Resumo por Bairro</h3>
              <div className="space-y-3">
                {stats.byNeighborhood.length > 0 ? stats.byNeighborhood.map(([name, count]) => (
                  <div key={name} className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-slate-300 uppercase">{name}</span>
                    <span className="text-[10px] font-black text-white bg-slate-800 px-2 py-0.5 rounded-lg">{count}</span>
                  </div>
                )) : <p className="text-[10px] text-slate-600 font-bold uppercase text-center py-4">Inicie uma mineração</p>}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'mine' && (
          <div className="space-y-8">
            <h2 className="text-2xl font-black text-white">Mineração</h2>
            <form onSubmit={handleStartMining} className="space-y-6">
              <div className="glass-card p-6 rounded-[2.5rem] space-y-4">
                <input type="text" value={niche} onChange={e => setNiche(e.target.value)} placeholder="O que busca? (ex: Academia)" className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-bold" />
                <div className="relative">
                  <input type="text" value={city} onChange={e => setCity(e.target.value)} onBlur={handleFetchNeighborhoods} placeholder="Qual cidade?" className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-bold" />
                  {loadingNeighborhoods && <div className="absolute right-4 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-500 animate-ping"></div>}
                </div>
              </div>
              {neighborhoodsList.length > 0 && (
                <div className="grid grid-cols-3 gap-2 animate-fadeIn">
                  {neighborhoodsList.map(n => (
                    <button key={n} type="button" onClick={() => setSelectedNeighborhoods(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n])} className={`p-2 rounded-xl text-[8px] font-black uppercase border transition-all ${selectedNeighborhoods.includes(n) ? 'bg-indigo-600 border-indigo-500 shadow-lg' : 'border-white/5 opacity-60'}`}>{n}</button>
                  ))}
                </div>
              )}
              <button disabled={isMining || selectedNeighborhoods.length === 0} className="w-full py-5 bg-indigo-600 rounded-full font-black text-xs uppercase shadow-xl flex items-center justify-center space-x-3 active:scale-95 disabled:opacity-50 transition-all">
                {isMining ? <><div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div><span>Extraindo...</span></> : <span>Iniciar Extração</span>}
              </button>
            </form>
            {(miningProgress || isMining) && (
              <div className="glass-card p-6 rounded-[2.5rem] space-y-4 border-indigo-500/20">
                <div className="flex justify-between items-center">
                  <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest animate-pulse">Minerando: {miningProgress?.active}</p>
                  {miningLog && <p className="text-[10px] font-black text-green-500">+{miningLog.new} NOVOS</p>}
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all duration-700" style={{ width: miningProgress ? `${(miningProgress.current / miningProgress.total) * 100}%` : '5%' }}></div>
                </div>
              </div>
            )}
            {/* Added Display for Grounding Sources to comply with rules */}
            {lastSources.length > 0 && (
              <div className="glass-card p-6 rounded-[2.5rem] space-y-3">
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Fontes de Grounding</h3>
                <div className="flex flex-col space-y-2">
                  {Array.from(new Set(lastSources.map(s => s.uri))).map((uri, idx) => {
                    const src = lastSources.find(s => s.uri === uri);
                    return (
                      <a key={idx} href={uri} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-indigo-400 truncate hover:underline underline-offset-2">
                        • {src?.title || uri}
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'leads' && (
          <div className="space-y-8">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-black text-white">Carteira</h2>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{filteredLeads.length} EMPRESAS</p>
              </div>
              <button onClick={() => setShowExportMenu(true)} className="p-3 glass rounded-xl text-indigo-400 active:scale-90"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg></button>
            </div>
            <div className="flex space-x-2 overflow-x-auto pb-4 custom-scrollbar">
              <button onClick={() => setActiveCampaignId(null)} className={`whitespace-nowrap px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase border transition-all ${!activeCampaignId ? 'bg-indigo-600 border-indigo-500 shadow-lg' : 'border-white/5 bg-slate-900/50'}`}>TODOS ({leads.length})</button>
              {campaigns.map(c => (
                <button key={c.id} onClick={() => setActiveCampaignId(c.id)} className={`whitespace-nowrap px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase border transition-all ${activeCampaignId === c.id ? 'bg-indigo-600 border-indigo-500 shadow-lg' : 'border-white/5 bg-slate-900/50'}`}>
                  {c.niche} ({leads.filter(l => l.campaignId === c.id).length})
                </button>
              ))}
            </div>
            <div className="grid gap-4">
              {filteredLeads.map(l => (
                <div key={l.id + l.campaignId} onClick={() => setSelectedLead(l)} className="glass-card p-5 rounded-[2rem] flex justify-between items-center active:scale-95 transition-transform cursor-pointer border-white/5">
                  <div className="space-y-1">
                    <h4 className="text-sm font-black text-white leading-none">{l.name}</h4>
                    <p className="text-[10px] text-slate-500 font-bold uppercase">{l.neighborhood} • {l.phone}</p>
                  </div>
                  <span className={`text-[9px] font-black px-3 py-1.5 rounded-full uppercase ${l.status === 'contacted' ? 'bg-slate-800 text-slate-500' : 'bg-green-500/10 text-green-500 border border-green-500/20'}`}>{l.status === 'contacted' ? 'Visto' : 'Novo'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-8">
            <h2 className="text-2xl font-black text-white">Configurações</h2>
            <div className="glass-card p-6 rounded-[2.5rem] space-y-6">
              <div className="flex justify-between items-center border-b border-white/5 pb-4">
                <span className="text-[10px] font-black text-slate-400 uppercase">Cloud Sync</span>
                <span className={`text-[10px] font-black uppercase ${cloudStatus === 'online' ? 'text-green-500' : 'text-amber-500'}`}>{cloudStatus}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-black text-slate-400 uppercase">Motor de Busca</span>
                <span className="text-[10px] font-black text-white">Gemini 3 Pro + Maps</span>
              </div>
              <div className="pt-4">
                <button onClick={() => { localStorage.clear(); window.location.reload(); }} className="w-full py-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-500 font-black text-[10px] uppercase">Resetar Dados Locais</button>
              </div>
            </div>
            <p className="text-center text-[9px] font-black text-slate-600 uppercase tracking-[0.2em]">LeadPro Hub v3.5</p>
          </div>
        )}
      </main>

      {/* MODAL EXPORT */}
      {showExportMenu && (
        <div className="fixed inset-0 z-[200] bg-[#0B0F1A]/95 backdrop-blur-xl flex items-end sm:items-center justify-center p-6 animate-fadeIn">
          <div className="w-full max-w-md glass-card rounded-[2.5rem] p-8 space-y-6">
            <h3 className="text-xl font-black text-white">Exportar</h3>
            <button onClick={() => performExport('current', 'whatsapp')} className="w-full p-5 bg-indigo-600/10 border border-indigo-600/20 rounded-2xl text-left">
              <p className="text-xs font-black text-white">Whats desta Campanha</p>
            </button>
            <button onClick={() => setShowExportMenu(false)} className="w-full p-4 glass rounded-2xl font-black text-[10px] uppercase text-slate-500">Fechar</button>
          </div>
        </div>
      )}

      {selectedLead && (
        <div className="fixed inset-0 z-[100] bg-[#0B0F1A] p-6 flex flex-col overflow-y-auto animate-fadeIn">
          <button onClick={() => setSelectedLead(null)} className="mb-8 p-4 glass w-fit rounded-2xl border-white/10"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg></button>
          <div className="flex flex-col items-center mb-10 text-center">
            <div className="w-24 h-24 bg-indigo-600 rounded-[2.5rem] flex items-center justify-center text-4xl font-black mb-6 shadow-2xl shadow-indigo-600/20">{selectedLead.name[0]}</div>
            <h2 className="text-2xl font-black px-4">{selectedLead.name}</h2>
            <p className="mt-2 text-indigo-400 font-black text-[10px] uppercase tracking-widest">{selectedLead.neighborhood} • {selectedLead.phone}</p>
          </div>
          <div className="space-y-4">
            <a href={selectedLead.whatsappUrl} target="_blank" rel="noreferrer" onClick={() => {
              const up = leads.map(l => l.id === selectedLead.id ? {...l, status: 'contacted' as const} : l);
              setLeads(up);
              saveLeadsToCloud([up.find(x => x.id === selectedLead.id)!]);
            }} className="w-full py-6 bg-[#25D366] rounded-[2rem] flex items-center justify-center space-x-3 shadow-xl shadow-green-500/20 active:scale-95 transition-all text-white font-black uppercase text-xs tracking-widest">
              Enviar WhatsApp
            </a>
            <div className="glass-card p-6 rounded-[2.5rem] space-y-5">
              <div className="flex justify-between items-center border-b border-white/5 pb-4">
                <h4 className="text-[10px] font-black text-indigo-400 uppercase">Script IA</h4>
                <button onClick={() => handleGeneratePitch(selectedLead)} className="text-[9px] bg-indigo-600/20 text-indigo-400 border border-indigo-600/30 px-4 py-2 rounded-full font-black uppercase hover:bg-indigo-600 transition-all">Gerar</button>
              </div>
              <p className="text-sm leading-relaxed text-slate-400 italic">"{selectedLead.notes || "Crie uma abordagem personalizada clicando acima."}"</p>
            </div>
          </div>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 glass border-t border-white/5 safe-bottom z-50 px-8 py-4 flex justify-between items-center rounded-t-[2.5rem]">
        <button onClick={() => setActiveTab('home')} className={`p-2 ${activeTab === 'home' ? 'text-indigo-400' : 'text-slate-600'}`}><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg></button>
        <button onClick={() => setActiveTab('mine')} className={`p-2 ${activeTab === 'mine' ? 'text-indigo-400' : 'text-slate-600'}`}><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></button>
        <button onClick={() => setActiveTab('leads')} className={`p-2 ${activeTab === 'leads' ? 'text-indigo-400' : 'text-slate-600'}`}><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg></button>
        <button onClick={() => setActiveTab('settings')} className={`p-2 ${activeTab === 'settings' ? 'text-indigo-400' : 'text-slate-600'}`}><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /></svg></button>
      </nav>
    </div>
  );
};

export default App;
