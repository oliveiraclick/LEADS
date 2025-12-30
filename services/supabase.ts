
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://whmthxpwthufwvpnzbgo.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndobXRoeHB3dGh1Znd2cG56YmdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMDk5ODcsImV4cCI6MjA4MjY4NTk4N30.YkWSzBkgMMl46EEdN6q0W_-VwBhRJWjNTGn5_Mp1ykE';

export const supabase = createClient(supabaseUrl, supabaseKey);

// Helper para salvar leads
export const saveLeadsToCloud = async (leads: any[]) => {
  try {
    const { error } = await supabase
      .from('leads')
      .upsert(leads, { onConflict: 'id,campaignId' });
    if (error) throw error;
  } catch (e) {
    console.warn("Supabase Sync Error (Leads):", e);
  }
};

// Helper para salvar campanhas
export const saveCampaignToCloud = async (campaign: any) => {
  try {
    const { error } = await supabase
      .from('campaigns')
      .upsert(campaign);
    if (error) throw error;
  } catch (e) {
    console.warn("Supabase Sync Error (Campaigns):", e);
  }
};

// Helper para deletar campanha
export const deleteCampaignFromCloud = async (id: string) => {
  try {
    const { error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.error("Erro ao deletar na nuvem:", e);
  }
};
