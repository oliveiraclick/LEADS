
export const neighborhoodsByCity: Record<string, string[]> = {
    "uberlandia": [
        "Centro", "Santa Mônica", "Umuarama", "Tibery", "Brasil", "Aparecida", "Saraiva",
        "Martins", "Roosevelt", "Luizote de Freitas", "Planalto", "Mansour", "Granada",
        "Laranjeiras", "Pampulha", "Custódio Pereira", "Santa Luzia", "Segismundo Pereira"
    ],
    "sao paulo": [
        "Itaim Bibi", "Vila Madalena", "Pinheiros", "Moema", "Jardins", "Brooklin",
        "Tatuapé", "Santana", "Mooca", "Vila Mariana", "Morumbi", "Perdizes", "Bela Vista",
        "Liberdade", "Ipiranga", "Santo Amaro", "Butantã", "Lapa", "Casa Verde"
    ],
    "rio de janeiro": [
        "Copacabana", "Ipanema", "Leblon", "Barra da Tijuca", "Recreio", "Botafogo",
        "Flamengo", "Tijuca", "Méier", "Madureira", "Campo Grande", "Jacarepaguá",
        "Centro", "Glória", "Santa Teresa", "Laranjeiras", "Humaitá"
    ],
    "belo horizonte": [
        "Savassi", "Lourdes", "Buritis", "Pampulha", "Castelo", "Funcionários", "Anchieta",
        "Sion", "Belvedere", "Centro", "Barro Preto", "Santa Efigênia", "Floresta"
    ],
    "curitiba": [
        "Batel", "Bigorrilho", "Água Verde", "Centro", "Santa Felicidade", "Portão",
        "Cabral", "Juvevê", "Mercês", "Rebouças", "Boqueirão", "Cajuru", "Pinheirinho"
    ]
};

export const getStaticNeighborhoods = (city: string): string[] | null => {
    const normCity = city.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    return neighborhoodsByCity[normCity] || null;
};
