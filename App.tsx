
import React, { useState, useEffect, useMemo } from 'react';
import { searchBusinesses, fetchNeighborhoods, generatePitch } from './services/gemini';
import { supabase, saveLeadsToCloud, saveCampaignToCloud, deleteCampaignFromCloud, deleteLeadFromCloud } from './services/supabase';
import { BusinessInfo, Campaign, GroundingSource } from './types';

const CAMPAIGNS_KEY = 'leadpro_campaigns_v3';
const LEADS_KEY = 'leadpro_leads_v3';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'mine' | 'leads' | 'settings'>('home');
  const [selectedLead, setSelectedLead] = useState<BusinessInfo | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [geminiApiKey, setGeminiApiKey] = useState<string>(localStorage.getItem('LP_GEMINI_API_KEY') || '');
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [groqApiKey, setGroqApiKey] = useState<string>(localStorage.getItem('LP_GROQ_API_KEY') || '');
  const [activeAI, setActiveAI] = useState<'gemini' | 'groq'>(localStorage.getItem('LP_ACTIVE_AI') as any || 'gemini');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [leadSearchQuery, setLeadSearchQuery] = useState('');

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [leads, setLeads] = useState<BusinessInfo[]>([]);

  const [niche, setNiche] = useState('');
  const [city, setCity] = useState('');
  const [neighborhoodsList, setNeighborhoodsList] = useState<string[]>([]);
  const [selectedNeighborhoods, setSelectedNeighborhoods] = useState<string[]>([]);
  const [loadingNeighborhoods, setLoadingNeighborhoods] = useState(false);
  const [isMining, setIsMining] = useState(false);
  const [miningLog, setMiningLog] = useState<{ new: number, skipped: number, mobile: number, landline: number } | null>(null);
  const [miningProgress, setMiningProgress] = useState<{ current: number, total: number, active: string, completed: string[] } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<'online' | 'sincronizando' | 'offline'>('online');
  const [lastSources, setLastSources] = useState<GroundingSource[]>([]);

  const normalize = (text: string) => (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

  useEffect(() => {
    const init = async () => {
      let rawCampaigns: Campaign[] = [];
      let rawLeads: BusinessInfo[] = [];

      // Load from localStorage first
      const savedC = localStorage.getItem(CAMPAIGNS_KEY);
      const savedL = localStorage.getItem(LEADS_KEY);
      if (savedC) rawCampaigns = JSON.parse(savedC);
      if (savedL) rawLeads = JSON.parse(savedL);

      // Initialize API Key for the service
      const savedKey = localStorage.getItem('LP_GEMINI_API_KEY');
      if (savedKey) (window as any).__LP_GEMINI_API_KEY = savedKey;

      try {
        const { data: cData } = await supabase.from('campaigns').select('*').order('createdAt', { ascending: true });
        const { data: lData } = await supabase.from('leads').select('*');

        // MERGE LOCAL + CLOUD
        if (cData) {
          const cMap = new Map<string, Campaign>();
          rawCampaigns.forEach(c => cMap.set(c.id, c));
          cData.forEach(c => cMap.set(c.id, c));
          rawCampaigns = Array.from(cMap.values());
        }
        if (lData) {
          const lMap = new Map<string, BusinessInfo>();
          rawLeads.forEach(l => lMap.set(`${l.id}_${l.campaignId}`, l));
          lData.forEach(l => lMap.set(`${l.id}_${l.campaignId}`, l));
          rawLeads = Array.from(lMap.values());
        }

        // MERGE DUPLICATES: Ensure only 1 campaign per niche
        const nicheMap = new Map<string, Campaign>();
        const campaignsToRemove: string[] = [];
        const leadRemapping: Record<string, string> = {};

        rawCampaigns.forEach(c => {
          const norm = normalize(c.niche);
          if (nicheMap.has(norm)) {
            const original = nicheMap.get(norm)!;
            campaignsToRemove.push(c.id);
            leadRemapping[c.id] = original.id;
          } else {
            nicheMap.set(norm, c);
          }
        });

        if (campaignsToRemove.length > 0) {
          console.log(`Merging ${campaignsToRemove.length} duplicate niches...`);
          rawCampaigns = Array.from(nicheMap.values());
          rawLeads = rawLeads.map(l => ({
            ...l,
            campaignId: leadRemapping[l.campaignId] || l.campaignId
          }));
          // Cleanup cloud duplicates and save merged associations
          await Promise.all(campaignsToRemove.map(id => deleteCampaignFromCloud(id)));
          await saveLeadsToCloud(rawLeads);
        }

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

  // FIX: Save API Keys to LocalStorage when they change
  useEffect(() => {
    if (geminiApiKey) {
      localStorage.setItem('LP_GEMINI_API_KEY', geminiApiKey);
      (window as any).__LP_GEMINI_API_KEY = geminiApiKey;
    }
    if (groqApiKey) {
      localStorage.setItem('LP_GROQ_API_KEY', groqApiKey);
    }
  }, [geminiApiKey, groqApiKey]);

  const stats = useMemo(() => {
    const neighborhoodMap: Record<string, number> = {};
    const statusMap: Record<string, number> = { new: 0, contacted: 0, interested: 0, closed: 0, rejected: 0 };
    leads.forEach(l => {
      neighborhoodMap[l.neighborhood] = (neighborhoodMap[l.neighborhood] || 0) + 1;
      statusMap[l.status] = (statusMap[l.status] || 0) + 1;
    });

    const converted = statusMap.interested + statusMap.closed;
    const conversionRate = leads.length > 0 ? Math.round((converted / leads.length) * 100) : 0;

    return {
      total: leads.length,
      campaigns: campaigns.length,
      byNeighborhood: Object.entries(neighborhoodMap).sort((a, b) => b[1] - a[1]).slice(0, 5),
      statusMap,
      conversionRate
    };
  }, [leads, campaigns]);

  const filteredLeads = useMemo(() => {
    let result = leads;
    if (activeCampaignId) {
      const targetNiche = campaigns.find(c => c.id === activeCampaignId)?.niche;
      if (targetNiche) {
        // Group all leads from campaigns with the same niche
        const relatedCampaignIds = campaigns.filter(c => c.niche === targetNiche).map(c => c.id);
        result = result.filter(l => relatedCampaignIds.includes(l.campaignId));
      }
    }
    if (statusFilter !== 'all') {
      result = result.filter(l => l.status === statusFilter);
    }
    if (leadSearchQuery) {
      const q = normalize(leadSearchQuery);
      result = result.filter(l => normalize(l.name).includes(q));
    }
    return result;
  }, [leads, activeCampaignId, statusFilter, leadSearchQuery]);

  const handleStartMining = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!niche || !city || selectedNeighborhoods.length === 0) return;

    setErrorMessage(null);
    setMiningLog({ new: 0, skipped: 0 });
    const normNiche = normalize(niche);
    const normCity = normalize(city);

    // Use normalizers for comparison - Folder is by NICHE only now
    const existingCampaign = campaigns.find(c => normalize(c.niche) === normalize(niche));

    let targetCampaignId = '';
    if (!existingCampaign) {
      const newCampaign: Campaign = {
        id: Date.now().toString(),
        niche: niche.toUpperCase(),
        city,
        createdAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString()
      };
      targetCampaignId = newCampaign.id;
      setCampaigns(prev => [newCampaign, ...prev]);
      await saveCampaignToCloud(newCampaign);
    } else {
      targetCampaignId = existingCampaign.id;
      const updatedCampaign = { ...existingCampaign, lastSyncAt: new Date().toISOString() };
      setCampaigns(prev => prev.map(c => c.id === existingCampaign.id ? updatedCampaign : c));
      await saveCampaignToCloud(updatedCampaign);
    }

    setIsMining(true);
    setCloudStatus('sincronizando');

    let currentLeadsState = [...leads];
    let totalNew = 0;
    let totalSkipped = 0;
    let totalMobile = 0;
    let totalLandline = 0;
    const allSources: GroundingSource[] = [];

    try {
      const processedBairros: string[] = [];
      for (let i = 0; i < selectedNeighborhoods.length; i++) {
        const barrio = selectedNeighborhoods[i];
        setMiningProgress({
          current: i + 1,
          total: selectedNeighborhoods.length,
          active: barrio,
          completed: [...processedBairros]
        });

        try {
          // Pequena pausa antes de cada busca para evitar 429
          await new Promise(r => setTimeout(r, 2000));

          const result = await searchBusinesses(niche, city, barrio, true, undefined, geminiApiKey);
          const batchToSave: any[] = [];

          if (result.sources) allSources.push(...result.sources);

          result.businesses.forEach(biz => {
            const bizPhone = normalize(biz.phone);
            const exists = currentLeadsState.some(l =>
              (l.id === biz.id && l.campaignId === targetCampaignId) ||
              (bizPhone !== '' && normalize(l.phone) === bizPhone)
            );
            if (!exists) {
              const leadData = { ...biz, campaignId: targetCampaignId, lastSeenAt: new Date().toISOString() };
              currentLeadsState.push(leadData);
              batchToSave.push(leadData);
              totalNew++;
              if (biz.type === 'mobile') totalMobile++;
              else totalLandline++;
            } else {
              totalSkipped++;
            }
          });

          setMiningLog({
            new: totalNew,
            skipped: totalSkipped,
            mobile: totalMobile,
            landline: totalLandline
          });

          if (batchToSave.length > 0) {
            await saveLeadsToCloud(batchToSave);
            setLeads([...currentLeadsState]);
          }

          processedBairros.push(barrio);
        } catch (err: any) {
          const msg = err.message || "";
          if (msg.includes('429')) {
            setErrorMessage("Cota diária do Google atingida. Mineramos até onde foi possível. Tente novamente em 1 hora para pegar o restante dos bairros.");
            break;
          } else if (msg.includes('API_KEY_MISSING')) {
            setErrorMessage("Erro: API Key não configurada. Vá na aba Configurações e insira sua chave do Google Gemini.");
            break;
          } else {
            console.error("Mining Error:", err);
            setErrorMessage("Ocorreu um erro inesperado. Verifique sua conexão e sua chave de API.");
          }
        }
      }
      setLastSources(allSources);
    } finally {
      setIsMining(false);
      setMiningProgress(null);
      setCloudStatus('online');
      if (!errorMessage && totalNew > 0) {
        setTimeout(() => { setActiveTab('leads'); setMiningLog(null); }, 2500);
      }
    }
  };

  const handleFetchNeighborhoods = async () => {
    if (!city) return;
    setLoadingNeighborhoods(true);
    try {
      const list = await fetchNeighborhoods(city, geminiApiKey);
      if (list && list.length > 0) {
        setNeighborhoodsList(list);
        setErrorMessage(null);
      } else {
        setErrorMessage("Nenhum bairro encontrado para esta cidade.");
      }
    } catch (err: any) {
      console.error("Neighborhood Fetch Error:", err);
      const msg = err.message || "";
      if (msg.includes('429')) {
        setErrorMessage("Limite de busca atingido (Cota Google). Tente novamente em breve.");
      } else if (msg.includes('API_KEY_INVALID') || msg.includes('API_KEY_MISSING')) {
        setErrorMessage("Erro: API Key do Gemini não encontrada ou inválida na aba Configurações.");
      } else if (msg.includes('generativelanguage.googleapis.com')) {
        setErrorMessage("Erro: A 'Generative Language API' não está ativada no seu projeto Google Cloud.");
      } else {
        setErrorMessage(`Falha na IA: ${msg.slice(0, 100) || "Erro desconhecido. Verifique sua chave e conexão."}`);
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

      let pitch = "";
      if (activeAI === 'groq' && groqApiKey) {
        const { generatePitchWithGroq } = await import('./services/groq');
        pitch = await generatePitchWithGroq(currentNiche, lead.name);
      } else {
        pitch = await generatePitch(currentNiche, lead.name, geminiApiKey);
      }

      const updatedLead = { ...lead, notes: pitch };
      setSelectedLead(updatedLead);
      setLeads(prev => prev.map(l => l.id === lead.id ? updatedLead : l));
      saveLeadsToCloud([updatedLead]);
    } catch (err: any) {
      console.error("Pitch Error:", err);
      const msg = err.message || "";
      if (msg.includes("GROQ_KEY_MISSING")) {
        setSelectedLead({ ...lead, notes: "Erro: Chave Groq não configurada." });
      } else {
        setSelectedLead({ ...lead, notes: "Limite atingido. Tente em breve." });
      }
    }
  };

  const handleDeleteCampaign = async (campaignId: string) => {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (!campaign) return;

    if (window.confirm(`Deseja realmente excluir a pasta "${campaign.niche}"? Isso removerá todos os leads desta categoria.`)) {
      try {
        setCloudStatus('sincronizando');

        const relatedCampaigns = campaigns.filter(c => normalize(c.niche) === normalize(campaign.niche));
        const idsToDelete = relatedCampaigns.map(c => c.id);

        for (const id of idsToDelete) {
          await deleteCampaignFromCloud(id);
        }

        setCampaigns(prev => prev.filter(c => !idsToDelete.includes(c.id)));
        setLeads(prev => prev.filter(l => !idsToDelete.includes(l.campaignId)));

        if (activeCampaignId && idsToDelete.includes(activeCampaignId)) {
          setActiveCampaignId(null);
        }
        alert("Excluído com sucesso!");
      } catch (err) {
        alert("Erro ao excluir. Verifique sua conexão.");
      } finally {
        setCloudStatus('online');
      }
    }
  };

  const handleCleanDuplicates = async () => {
    const phoneMap = new Map<string, BusinessInfo>();
    const dupesFound: BusinessInfo[] = [];
    const keptLeads: BusinessInfo[] = [];

    const targetLeads = activeCampaignId
      ? leads.filter(l => {
        const niche = campaigns.find(c => c.id === activeCampaignId)?.niche;
        return niche && campaigns.filter(c => c.niche === niche).map(c => c.id).includes(l.campaignId);
      })
      : leads;

    const sortedLeads = [...targetLeads].sort((a, b) =>
      new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime()
    );

    sortedLeads.forEach(l => {
      const phone = normalize(l.phone);
      if (phone && phoneMap.has(phone)) {
        dupesFound.push(l);
      } else {
        if (phone) phoneMap.set(phone, l);
        keptLeads.push(l);
      }
    });

    if (dupesFound.length === 0) {
      alert("Nenhum lead duplicado encontrado nesta pasta.");
      return;
    }

    if (confirm(`Encontramos ${dupesFound.length} leads repetidos nesta pasta. Deseja realizar a limpeza agora?`)) {
      setCloudStatus('sincronizando');
      try {
        for (const d of dupesFound) {
          await deleteLeadFromCloud(d.id, d.campaignId);
        }

        // Remove only the dupes from the global state
        const dupeIds = new Set(dupesFound.map(d => `${d.id}_${d.campaignId}`));
        setLeads(prev => prev.filter(l => !dupeIds.has(`${l.id}_${l.campaignId}`)));

        alert(`Limpeza concluída! ${dupesFound.length} duplicados removidos.`);
      } catch (err) {
        alert("Erro durante a limpeza. Verifique sua conexão.");
      } finally {
        setCloudStatus('online');
      }
    }
  };

  // Fixed missing performExport function
  const performExport = (scope: 'current' | 'all', format: 'whatsapp' | 'csv' | 'vcf', filter: 'all' | 'mobile' = 'all') => {
    let list = scope === 'current' ? filteredLeads : leads;

    if (filter === 'mobile') {
      list = list.filter(l => l.type === 'mobile');
    }

    if (list.length === 0) {
      alert("Nenhum contato encontrado com este filtro.");
      return;
    }

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
    } else if (format === 'csv') {
      const headers = ['Nome', 'Telefone', 'Bairro', 'Tipo', 'Status'];
      const rows = list.map(l => [
        l.name,
        l.phone,
        l.neighborhood,
        l.type === 'mobile' ? 'Celular/WhatsApp' : 'Fixo',
        l.status
      ]);

      const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
      const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `leads_${filter === 'mobile' ? 'whats_' : ''}${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setShowExportMenu(false);
    } else if (format === 'vcf') {
      // VCF Export Logic
      const vcardContent = list.map(l => {
        const cleanPhone = l.phone.replace(/\D/g, '');
        // Ensure +55 for Brazil if missing (heuristic)
        const formattedPhone = cleanPhone.startsWith('55') ? '+' + cleanPhone : '+55' + cleanPhone;

        return [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `FN:LP ${l.name}`,
          `NOTE:Nicho: ${l.niche || 'Geral'} | Bairro: ${l.neighborhood}`,
          `TEL;TYPE=CELL:${formattedPhone}`,
          'END:VCARD'
        ].join('\n');
      }).join('\n');

      const blob = new Blob([vcardContent], { type: 'text/vcard;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `contatos_leads_${new Date().toISOString().slice(0, 10)}.vcf`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setShowExportMenu(false);
    }
  };

  const handleSaveKeys = () => {
    try {
      const gKey = geminiApiKey.trim();
      const grKey = groqApiKey.trim();

      if (!gKey && !grKey) {
        alert("Por favor, insira pelo menos uma chave de API.");
        return;
      }

      if (gKey) {
        localStorage.setItem('LP_GEMINI_API_KEY', gKey);
        (window as any).__LP_GEMINI_API_KEY = gKey;
      }
      if (grKey) {
        localStorage.setItem('LP_GROQ_API_KEY', grKey);
      }

      setApiKeySaved(true);
      alert("Chaves Salvas via Bootloader! Vamos testar a conexão.");
      setActiveTab('mine');
      setTimeout(() => setApiKeySaved(false), 2000);

    } catch (err: any) {
      alert("Erro crítico de armazenamento: " + (err.message || "Seu navegador móvel pode estar bloqueando cookies (Modo Privado?)."));
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
            <div className="glass-card p-6 rounded-[2.5rem] space-y-4 bg-indigo-500/5 border-indigo-500/20">
              <div className="flex justify-between items-center">
                <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest border-b border-white/5 pb-2">Taxa de Conversão</h3>
                <span className="text-xl font-black text-white">{stats.conversionRate}%</span>
              </div>
              <div className="w-full h-3 bg-slate-900 rounded-full overflow-hidden p-0.5 border border-white/5">
                <div className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full transition-all duration-1000 shadow-[0_0_10px_rgba(16,185,129,0.3)]" style={{ width: `${stats.conversionRate}%` }}></div>
              </div>
              <div className="grid grid-cols-4 gap-2 pt-2">
                <div className="text-center">
                  <p className="text-xs font-black text-indigo-400">{stats.statusMap.interested}</p>
                  <p className="text-[7px] font-bold text-slate-500 uppercase">Interess.</p>
                </div>
                <div className="text-center">
                  <p className="text-xs font-black text-emerald-500">{stats.statusMap.closed}</p>
                  <p className="text-[7px] font-bold text-slate-500 uppercase">Fechados</p>
                </div>
                <div className="text-center">
                  <p className="text-xs font-black text-blue-500">{stats.statusMap.contacted}</p>
                  <p className="text-[7px] font-bold text-slate-500 uppercase">Vistos</p>
                </div>
                <div className="text-center">
                  <p className="text-xs font-black text-red-500">{stats.statusMap.rejected}</p>
                  <p className="text-[7px] font-bold text-slate-500 uppercase">Rejeit.</p>
                </div>
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

            {/* DEBUG: API Key Status Indicator */}
            <div className={`p-3 rounded-2xl border flex items-center justify-between ${geminiApiKey ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
              <span className="text-[10px] font-black uppercase text-slate-400">Status da Chave Gemini</span>
              <span className={`text-[10px] font-black uppercase ${geminiApiKey ? 'text-emerald-400' : 'text-red-400'}`}>
                {geminiApiKey ? 'OK - Conectado' : 'Não Configurada'}
              </span>
            </div>

            <form onSubmit={handleStartMining} className="space-y-6">
              <div className="glass-card p-6 rounded-[2.5rem] space-y-4">
                <input type="text" value={niche} onChange={e => setNiche(e.target.value)} placeholder="O que busca? (ex: Academia)" className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-bold" />
                <div className="relative">
                  <input
                    type="text"
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    onBlur={handleFetchNeighborhoods}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleFetchNeighborhoods())}
                    placeholder="Qual cidade? (Pressione Enter)"
                    className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-bold"
                  />
                  {loadingNeighborhoods && <div className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>}
                </div>
              </div>
              {neighborhoodsList.length > 0 && (
                <div className="grid grid-cols-3 gap-2 animate-fadeIn">
                  {neighborhoodsList.map(n => (
                    <button key={n} type="button" onClick={() => setSelectedNeighborhoods(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n])} className={`p-2 rounded-xl text-[8px] font-black uppercase border transition-all ${selectedNeighborhoods.includes(n) ? 'bg-indigo-600 border-indigo-500 shadow-lg' : 'border-white/5 opacity-60'}`}>{n}</button>
                  ))}
                </div>
              )}
              <button disabled={isMining || selectedNeighborhoods.length === 0 || !geminiApiKey} className="w-full py-5 bg-indigo-600 rounded-full font-black text-xs uppercase shadow-xl flex items-center justify-center space-x-3 active:scale-95 disabled:opacity-50 disabled:grayscale transition-all">
                {isMining ? (
                  <><div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div><span>Extraindo...</span></>
                ) : !geminiApiKey ? (
                  <span>Configure a API Key Primeiro</span>
                ) : (
                  <span>Iniciar Extração</span>
                )}
              </button>
            </form>
            {isMining && (
              <div className="glass-card p-6 rounded-[2.5rem] space-y-6 border-indigo-500/30 bg-indigo-500/5 animate-fadeIn">
                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center p-3 bg-slate-900/50 rounded-2xl border border-white/5">
                    <p className="text-[8px] font-black text-slate-500 uppercase mb-1">Total</p>
                    <p className="text-lg font-black text-white">{miningLog?.new || 0}</p>
                  </div>
                  <div className="text-center p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
                    <p className="text-[8px] font-black text-emerald-500 uppercase mb-1">Celular</p>
                    <p className="text-lg font-black text-white">{miningLog?.mobile || 0}</p>
                  </div>
                  <div className="text-center p-3 bg-blue-500/10 rounded-2xl border border-blue-500/20">
                    <p className="text-[8px] font-black text-blue-500 uppercase mb-1">Fixo</p>
                    <p className="text-lg font-black text-white">{miningLog?.landline || 0}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-end">
                    <div className="space-y-1">
                      <p className="text-[9px] font-black text-indigo-400 uppercase tracking-widest animate-pulse">Minerando Agora</p>
                      <h3 className="text-lg font-black text-white truncate max-w-[200px]">{miningProgress?.active || "Carregando..."}</h3>
                    </div>
                    <p className="text-[10px] font-bold text-slate-500 uppercase">{miningProgress?.current} / {miningProgress?.total}</p>
                  </div>

                  <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-white/5">
                    <div className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-500 bg-[length:200%_100%] animate-[shimmer_2s_infinite_linear] transition-all duration-700" style={{ width: miningProgress ? `${(miningProgress.current / miningProgress.total) * 100}%` : '5%' }}></div>
                  </div>
                </div>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                  {selectedNeighborhoods.map(n => {
                    const isCompleted = miningProgress?.completed.includes(n);
                    const isActive = miningProgress?.active === n;
                    return (
                      <div key={n} className={`flex justify-between items-center p-3 rounded-2xl transition-all ${isActive ? 'bg-indigo-500/10 border border-indigo-500/20' : 'bg-slate-900/30'}`}>
                        <span className={`text-[10px] font-bold uppercase ${isCompleted ? 'line-through text-slate-600' : isActive ? 'text-white' : 'text-slate-500'}`}>{n}</span>
                        {isCompleted ? (
                          <span className="w-5 h-5 flex items-center justify-center bg-emerald-500 rounded-full text-[10px]">✓</span>
                        ) : isActive ? (
                          <div className="w-4 h-4 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-white/10"></div>
                        )}
                      </div>
                    );
                  })}
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
          <div className="space-y-8 animate-fadeIn">
            {!activeCampaignId ? (
              // FOLDER VIEW
              <div className="space-y-8">
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-2xl font-black text-white">Carteira</h2>
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{campaigns.length} CATEGORIAS</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={() => setShowExportMenu(true)} className="flex flex-col items-center bg-indigo-500/10 border border-indigo-500/20 px-4 py-3 rounded-2xl active:scale-95 transition-all">
                      <svg className="w-5 h-5 text-indigo-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      <span className="text-[8px] font-black text-indigo-400 uppercase">Exportar</span>
                    </button>
                  </div>
                </div>

                {campaigns.length === 0 ? (
                  <div className="glass-card p-12 text-center rounded-[3rem] border-white/5 space-y-4">
                    <div className="mx-auto w-16 h-16 bg-slate-900 rounded-2xl flex items-center justify-center text-slate-700">
                      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                    </div>
                    <p className="text-xs font-bold text-slate-500 uppercase">Nenhuma extração realizada ainda.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    {/* Unique Niches for Folders */}
                    {Array.from(new Set(campaigns.map(c => c.niche))).map(nicheName => {
                      const nicheCampaigns = campaigns.filter(c => c.niche === nicheName);
                      const firstCampaign = nicheCampaigns[0];
                      const leadsInNiche = leads.filter(l => nicheCampaigns.some(c => c.id === l.campaignId)).length;

                      return (
                        <div key={nicheName} className="relative group">
                          <button
                            onClick={() => setActiveCampaignId(firstCampaign.id)}
                            className="w-full glass-card p-6 rounded-[2.5rem] border-white/5 flex flex-col items-center text-center space-y-4 active:scale-95 transition-all hover:border-indigo-500/30"
                          >
                            <div className="w-16 h-16 bg-indigo-600/10 rounded-2xl flex items-center justify-center text-indigo-500 shadow-inner">
                              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                            </div>
                            <div className="w-full">
                              <h3 className="text-sm font-black text-white uppercase truncate w-full">{nicheName}</h3>
                              <p className="text-[9px] font-black text-slate-500 mt-1">{leadsInNiche} LEADS</p>
                            </div>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Apagar todos os leads de ${nicheName}?`)) {
                                nicheCampaigns.forEach(c => handleDeleteCampaign(c.id));
                              }
                            }}
                            className="absolute top-4 right-4 p-2 text-red-500/20 hover:text-red-500 transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              // DETAIL VIEW
              <div className="space-y-6 animate-fadeIn">
                <div className="flex items-center space-x-4">
                  <button onClick={() => setActiveCampaignId(null)} className="p-3 glass rounded-2xl text-slate-500 hover:text-white transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  </button>
                  <div>
                    <h2 className="text-xl font-black text-white uppercase italic">{campaigns.find(c => c.id === activeCampaignId)?.niche}</h2>
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">{filteredLeads.length} RESULTADOS</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={leadSearchQuery}
                      onChange={e => setLeadSearchQuery(e.target.value)}
                      placeholder="Buscar nesta pasta..."
                      className="w-full bg-slate-900/50 border border-white/5 p-4 pl-12 rounded-[1.5rem] text-sm font-bold text-white placeholder-slate-600 focus:border-indigo-500/50 transition-all outline-none"
                    />
                    <svg className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  </div>
                  <button onClick={handleCleanDuplicates} className="p-4 glass rounded-[1.5rem] text-amber-500 active:scale-90 border-amber-500/20 flex items-center justify-center space-x-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    <span className="text-[8px] font-black uppercase">Limpar</span>
                  </button>
                </div>

                <div className="flex space-x-2 overflow-x-auto pb-2 custom-scrollbar no-scrollbar">
                  <button
                    onClick={() => setStatusFilter('all')}
                    className={`whitespace-nowrap px-4 py-2 rounded-xl text-[9px] font-black uppercase border transition-all ${statusFilter === 'all' ? 'bg-slate-800 text-white border-white/20' : 'border-white/5 text-slate-500'}`}
                  >
                    Todos
                  </button>
                  {[
                    { id: 'new', label: 'Novos' },
                    { id: 'contacted', label: 'Vistos' },
                    { id: 'interested', label: 'Interessados' },
                    { id: 'closed', label: 'Fechados' },
                    { id: 'rejected', label: 'Rejeitados' }
                  ].map(s => (
                    <button
                      key={s.id}
                      onClick={() => setStatusFilter(s.id)}
                      className={`whitespace-nowrap px-4 py-2 rounded-xl text-[9px] font-black uppercase border transition-all ${statusFilter === s.id ? 'bg-slate-800 text-white border-white/20' : 'border-white/5 text-slate-500'}`}
                    >
                      {s.label} ({leads.filter(l => l.status === s.id && l.campaignId === activeCampaignId).length})
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
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-8">
            <h2 className="text-2xl font-black text-white">Configurações</h2>

            <div className="glass-card p-6 rounded-[2.5rem] space-y-4 border-indigo-500/20">
              <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest border-b border-white/5 pb-3">Inteligência Ativa</h3>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => { setActiveAI('gemini'); localStorage.setItem('LP_ACTIVE_AI', 'gemini'); }} className={`p-4 rounded-2xl border font-black text-[10px] uppercase transition-all ${activeAI === 'gemini' ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900/50 border-white/5 text-slate-500'}`}>Gemini (Mineração)</button>
                <button onClick={() => { setActiveAI('groq'); localStorage.setItem('LP_ACTIVE_AI', 'groq'); }} className={`p-4 rounded-2xl border font-black text-[10px] uppercase transition-all ${activeAI === 'groq' ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900/50 border-white/5 text-slate-500'}`}>Groq (Ultra-Rápido)</button>
              </div>
            </div>

            <div className="glass-card p-6 rounded-[2.5rem] space-y-4 border-indigo-500/20">
              <div className="flex justify-between items-center border-b border-white/5 pb-3">
                <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Google Gemini</h3>
                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[8px] font-black text-indigo-400 uppercase hover:underline">Pegar Chave Grátis →</a>
              </div>
              <div className="relative">
                <input
                  type={showGeminiKey ? "text" : "password"}
                  value={geminiApiKey}
                  onChange={e => setGeminiApiKey(e.target.value)}
                  placeholder="Google API Key..."
                  className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-mono text-xs pr-12"
                />
                <button
                  onClick={() => setShowGeminiKey(!showGeminiKey)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 p-2 active:scale-90 transition-transform"
                >
                  {showGeminiKey ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  )}
                </button>
              </div>
            </div>

            <div className="glass-card p-6 rounded-[2.5rem] space-y-4 border-emerald-500/20">
              <div className="flex justify-between items-center border-b border-white/5 pb-3">
                <h3 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Groq Cloud</h3>
                <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-[8px] font-black text-emerald-400 uppercase hover:underline">Pegar Chave Grátis →</a>
              </div>
              <input
                type="password"
                value={groqApiKey}
                onChange={e => setGroqApiKey(e.target.value)}
                placeholder="Groq API Key..."
                className="w-full bg-slate-900 border-none p-4 rounded-xl text-white font-mono text-xs"
              />
            </div>

            <button
              onClick={handleSaveKeys}
              className={`w-full py-5 rounded-full font-black text-xs uppercase transition-all shadow-xl active:scale-95 ${apiKeySaved ? 'bg-emerald-500 text-white' : 'bg-indigo-600'}`}
            >
              {apiKeySaved ? 'Salvo! Redirecionando...' : 'Salvar e Testar Agora'}
            </button>

            <div className="glass-card p-6 rounded-[2.5rem] space-y-6">
              <div className="flex justify-between items-center border-b border-white/5 pb-4">
                <span className="text-[10px] font-black text-slate-400 uppercase">Cloud Sync</span>
                <span className={`text-[10px] font-black uppercase ${cloudStatus === 'online' ? 'text-green-500' : 'text-amber-500'}`}>{cloudStatus}</span>
              </div>
              <div className="pt-4">
                <button onClick={() => { if (confirm("Cuidado: Isso apagará todas as suas campanhas salvas. Continuar?")) { localStorage.clear(); window.location.reload(); } }} className="w-full py-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-500 font-black text-[10px] uppercase">Resetar Tudo</button>
              </div>
            </div>
            <p className="text-center text-[9px] font-black text-slate-600 uppercase tracking-[0.2em]">LeadPro Hub v3.5 • Free Stack Edition</p>
          </div>
        )}
      </main>

      {/* MODAL EXPORT */}
      {showExportMenu && (
        <div className="fixed inset-0 z-[200] bg-[#0B0F1A]/95 backdrop-blur-xl flex items-end sm:items-center justify-center p-6 animate-fadeIn">
          <div className="w-full max-w-md glass-card rounded-[2.5rem] p-8 space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-black text-white">Exportar Lista</h3>
              <button onClick={() => setShowExportMenu(false)} className="text-slate-500 hover:text-white transition-colors"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>

            <div className="space-y-3">
              <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest pl-1">Escolha o filtro</p>

              <button onClick={() => performExport('current', 'csv', 'all')} className="w-full p-4 bg-slate-900 border border-white/5 rounded-2xl text-left flex justify-between items-center group active:scale-95 transition-all">
                <div>
                  <p className="text-xs font-black text-white">Todos os Contatos (CSV)</p>
                  <p className="text-[8px] text-slate-500 font-bold uppercase mt-1">Geral desta campanha</p>
                </div>
                <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              </button>

              <button onClick={() => performExport('current', 'csv', 'mobile')} className="w-full p-4 bg-[#25D366]/10 border border-[#25D366]/20 rounded-2xl text-left flex justify-between items-center group active:scale-95 transition-all">
                <div>
                  <p className="text-xs font-black text-white">Apenas WhatsApp (CSV)</p>
                  <p className="text-[8px] text-slate-500 font-bold uppercase mt-1">Filtra apenas celulares</p>
                </div>
                <div className="bg-[#25D366] p-1.5 rounded-lg">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.185-.573c.948.517 2.042.827 3.144.828 3.182 0 5.767-2.587 5.768-5.767 0-3.18-2.585-5.766-5.766-5.766zm3.361 8.249c-.14.394-.716.711-1.18.755-.464.045-1.055.247-2.311-.274-1.256-.522-2.37-1.854-2.839-2.483-.178-.239-.739-.984-.739-1.879 0-.895.467-1.334.633-1.52.166-.187.365-.234.482-.234s.233.003.334.007c.101.004.237-.038.371.286.134.324.457 1.111.497 1.191.04.081.067.175.013.284-.054.108-.081.175-.162.27-.081.095-.171.21-.244.284-.081.081-.166.17-.071.332.095.162.423.699.907 1.13.623.555 1.148.727 1.31.81.162.083.256.068.351-.041.095-.108.406-.475.514-.637.108-.162.216-.135.365-.081.148.054.919.434 1.081.514.162.081.27.122.311.19.04.068.04.393-.101.787z" /></svg>
                </div>
              </button>

              <button onClick={() => performExport('current', 'vcf', 'mobile')} className="w-full p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-left flex justify-between items-center group active:scale-95 transition-all">
                <div>
                  <p className="text-xs font-black text-white">Salvar na Agenda (VCF)</p>
                  <p className="text-[8px] text-slate-500 font-bold uppercase mt-1">Importação Automática</p>
                </div>
                <div className="bg-amber-500 p-1.5 rounded-lg text-white">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" /></svg>
                </div>
              </button>

              <div className="pt-2">
                <button onClick={() => performExport('current', 'whatsapp', 'mobile')} className="w-full p-4 bg-indigo-600 rounded-2xl text-center space-x-2 active:scale-95 transition-all">
                  <span className="text-xs font-black text-white uppercase tracking-widest">Copiar WhatsApps</span>
                </button>
              </div>
            </div>
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

            <div className="flex space-x-3 mt-6">
              {selectedLead.instagram && (
                <a href={selectedLead.instagram.startsWith('@') ? `https://instagram.com/${selectedLead.instagram.slice(1)}` : selectedLead.instagram} target="_blank" rel="noreferrer" className="p-3 glass rounded-2xl text-pink-500 active:scale-90 transition-all">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.335 3.608 1.31.975.975 1.248 2.242 1.31 3.608.058 1.266.069 1.646.069 4.85s-.011 3.584-.069 4.85c-.062 1.366-.335 2.633-1.31 3.608-.975.975-2.242 1.248-3.608 1.31-1.266.058-1.646.069-4.85.069s-3.584-.011-4.85-.069c-1.366-.062-2.633-.335-3.608-1.31-.975-.975-1.248-2.242-1.31-3.608-.058-1.266-.069-1.646-.069-4.85s.011-3.584.069-4.85c.062-1.366.335-2.633 1.31-3.608.975-.975 2.242-1.248 3.608-1.31 1.266-.058 1.646-.069 4.85-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.947.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.947-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.058-1.69-.072-4.949-.072zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" /></svg>
                </a>
              )}
              {selectedLead.website && (
                <a href={selectedLead.website.startsWith('http') ? selectedLead.website : `https://${selectedLead.website}`} target="_blank" rel="noreferrer" className="p-3 glass rounded-2xl text-indigo-400 active:scale-90 transition-all">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
                </a>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div className="glass-card p-6 rounded-[2.5rem] space-y-4">
              <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-white/5 pb-3">Status do Lead</h4>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'new', label: 'Novo', color: 'bg-green-500/10 text-green-500 border-green-500/20' },
                  { id: 'contacted', label: 'Contatado', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
                  { id: 'interested', label: 'Interessado', color: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
                  { id: 'closed', label: 'Fechado', color: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
                  { id: 'rejected', label: 'Rejeitado', color: 'bg-red-500/10 text-red-500 border-red-500/20' }
                ].map(s => (
                  <button
                    key={s.id}
                    onClick={() => {
                      const updatedLead = { ...selectedLead, status: s.id as any };
                      setSelectedLead(updatedLead);
                      setLeads(prev => prev.map(l => l.id === selectedLead.id ? updatedLead : l));
                      saveLeadsToCloud([updatedLead]);
                    }}
                    className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase border transition-all ${selectedLead.status === s.id ? s.color : 'border-white/5 text-slate-600'}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <a href={selectedLead.whatsappUrl} target="_blank" rel="noreferrer" onClick={() => {
              const up = leads.map(l => l.id === selectedLead.id ? { ...l, status: 'contacted' as const } : l);
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
