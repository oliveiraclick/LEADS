
export interface BusinessInfo {
  id: string;
  name: string;
  phone: string;
  whatsappUrl: string;
  instagram?: string;
  facebook?: string;
  email?: string;
  website?: string;
  status: 'new' | 'contacted' | 'interested' | 'closed' | 'rejected' | 'outdated';
  neighborhood: string;
  type: 'mobile' | 'landline' | 'unknown';
  notes?: string;
  // lastSeenAt and campaignId are made optional because they are only available after a search result is saved to a campaign
  lastSeenAt?: string; // Data da última vez que foi encontrado na busca
  campaignId?: string;
}

export interface Campaign {
  id: string;
  niche: string;
  city: string;
  createdAt: string;
  lastSyncAt: string;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface SearchResult {
  text: string;
  businesses: BusinessInfo[];
  sources: GroundingSource[];
}
