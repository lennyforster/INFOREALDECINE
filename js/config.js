/**
 * Configuración de la aplicación Info Real de Cine.
 * Puedes cambiar la clave TMDB o la URL del CSV aquí.
 */
const CONFIG = {
    TMDB_API_KEY: 'f528e89e050fe5b9a8072cf4c539e542',
    OMDB_API_KEY: 'e8d69f34',
    TMDB_BASE_URL: 'https://api.themoviedb.org/3',
    TMDB_IMAGE_BASE: 'https://image.tmdb.org/t/p',
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSn2LLmNc6a8NJcD_tyk9S6TFyFJcxEp8vTESCgNFsG_y-P3Ju3TRnxHxXlePcb4a5yV6YpTIFu-Ohu/pub?gid=0&single=true&output=csv',
    SEARCH_DEBOUNCE_MS: 300,
    POSTER_CONCURRENT_MAX: 4,
    POSTER_CACHE_KEY: 'inforeal_poster_cache',
    POSTER_CACHE_DAYS: 7
};
