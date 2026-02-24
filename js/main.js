document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
});

let movieData = [];
        // Variable global para el filtro actual
        let currentFilter = {
            type: null, // 'search', 'director', 'year', 'tag', null
            value: null
        };
        let currentSort = {
            column: null,
            ascending: true,
            clicks: 0
        };
        let currentView = 'gallery';
        let currentPage = 1;
        let moviesPerPage = 12;
        let filteredMovies = [];
        let posterStats = {
            total: 0,
            loaded: 0,
            failed: 0,
            pending: 0
        };

        const tmdbCache = {};
        const maxConcurrentPosters = typeof CONFIG !== 'undefined' ? (CONFIG.POSTER_CONCURRENT_MAX || 4) : 4;
        let concurrentPosterLoads = 0;
        const posterQueue = [];
        let posterObserver = null;

        function registerPosterForLazyLoad(posterElement) {
            if (!posterObserver) {
                posterObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) return;
                        const el = entry.target;
                        if (el.dataset.loaded === '1') return;
                        posterObserver.unobserve(el);
                        processPosterQueue(el);
                    });
                }, { rootMargin: '100px', threshold: 0.01 });
            }
            posterObserver.observe(posterElement);
        }

        function processPosterQueue(posterElement) {
            const title = posterElement.dataset.movieTitle || '';
            const year = posterElement.dataset.movieYear || '';
            const posterLink = (posterElement.dataset.posterLink || '').trim().replace(/^"|"$/g, '').replace(/\s+/g, '');
            if (posterElement.dataset.loaded === '1') return;
            posterElement.dataset.loaded = '1';

            if (posterLink) {
                const img = new Image();
                img.onload = function() {
                    posterElement.style.backgroundImage = `url('${posterLink}')`;
                    posterElement.classList.add('loaded');
                    posterElement.dataset.posterSource = 'link';
                    loadPosterFromTMDB(title, year, posterElement);
                };
                img.onerror = function() {
                    const proxyUrl = 'https://images.weserv.nl/?url=' + encodeURIComponent(posterLink) + '&w=300&h=450&fit=cover&output=jpg&q=85';
                    const px = new Image();
                    px.onload = function() {
                        posterElement.style.backgroundImage = `url('${proxyUrl}')`;
                        posterElement.classList.add('loaded');
                        posterElement.dataset.posterSource = 'link';
                        loadPosterFromTMDB(title, year, posterElement);
                    };
                    px.onerror = function() {
                        loadPosterFromTMDB(title, year, posterElement);
                    };
                    px.src = proxyUrl;
                };
                img.src = posterLink;
                return;
            }
            loadPosterFromTMDB(title, year, posterElement);
        }

        // No usada: MyMemory tiene límite diario gratuito; mostramos texto en inglés con "(en inglés)".
        function translateEnToEs(text) {
            if (!text || !text.trim()) return Promise.resolve('');
            const maxLen = 480;
            var toTranslate = text.trim();
            var truncated = false;
            if (toTranslate.length > maxLen) {
                toTranslate = toTranslate.substring(0, maxLen);
                truncated = true;
            }
            if (truncated) toTranslate = toTranslate.trim() + '...';
            const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(toTranslate) + '&langpair=en|es';
            return fetch(url)
                .then(r => r.json())
                .then(function(data) {
                    const t = data && data.responseData && data.responseData.translatedText;
                    var result = (t && t.trim()) ? t.trim() : text;
                    if (truncated && result && !result.endsWith('...')) result = result + '...';
                    return result;
                })
                .catch(function() { return text; });
        }

        function tryWikipediaSynopsis(title, year) {
            if (!title || !title.trim()) return Promise.resolve('');
            var searchTerms = [title.trim() + (year ? ' ' + year : '') + ' film', title.trim() + (year ? ' (' + year + ')' : ''), title.trim() + (year ? ' ' + year : '')];
            function wikiFetchOne(apiBase, term) {
                var searchUrl = apiBase + '?action=query&list=search&srsearch=' + encodeURIComponent(term) + '&format=json&origin=*&utf8=1';
                return fetch(searchUrl)
                    .then(function(r) { return r.json(); })
                    .then(function(data) {
                        var list = data && data.query && data.query.search;
                        if (!list || list.length === 0) return '';
                        var pageId = list[0].pageid;
                        var extractUrl = apiBase + '?action=query&prop=extracts&exintro&exsentences=6&explaintext&pageids=' + pageId + '&format=json&origin=*';
                        return fetch(extractUrl).then(function(r2) { return r2.json(); });
                    })
                    .then(function(data) {
                        if (!data || !data.query || !data.query.pages) return '';
                        var pages = data.query.pages;
                        var pageId = Object.keys(pages)[0];
                        if (!pageId || pageId === '-1') return '';
                        var extract = pages[pageId].extract;
                        if (!extract || typeof extract !== 'string') return '';
                        var text = extract.trim();
                        if (text.length < 60) return '';
                        if (text.length > 650) text = text.substring(0, 647) + '...';
                        return text;
                    })
                    .catch(function() { return ''; });
            }
            function tryAllTerms(apiBase) {
                return wikiFetchOne(apiBase, searchTerms[0]).then(function(t) {
                    if (t) return t;
                    return wikiFetchOne(apiBase, searchTerms[1]);
                }).then(function(t) {
                    if (t) return t;
                    return wikiFetchOne(apiBase, searchTerms[2]);
                });
            }
            return tryAllTerms('https://es.wikipedia.org/w/api.php').then(function(t) {
                if (t) return t;
                return tryAllTerms('https://en.wikipedia.org/w/api.php');
            });
        }

        function fallbackSynopsisText(posterElement, title, year) {
            var director = (posterElement && posterElement.dataset && posterElement.dataset.movieDirector) ? String(posterElement.dataset.movieDirector).trim() : '';
            if (year && director) return 'Película de ' + year + ', dirigida por ' + director + '. Sinopsis no disponible en las fuentes consultadas.';
            if (year) return 'Película de ' + year + '. Sinopsis no disponible en las fuentes consultadas.';
            if (director) return 'Dirigida por ' + director + '. Sinopsis no disponible en las fuentes consultadas.';
            return 'Sinopsis no disponible en las fuentes consultadas.';
        }

        function tryOMDbSynopsis(title, year) {
            var key = typeof CONFIG !== 'undefined' ? CONFIG.OMDB_API_KEY : '';
            if (!key || !title || !title.trim()) return Promise.resolve('');
            function doRequest(y) {
                var url = 'https://www.omdbapi.com/?t=' + encodeURIComponent(title.trim()) + '&apikey=' + key;
                if (y) url += '&y=' + y;
                return fetch(url).then(function(r) { return r.json(); }).then(function(data) {
                    var plot = data && data.Plot;
                    if (!plot || typeof plot !== 'string' || plot === 'N/A') return '';
                    var text = plot.trim();
                    if (text.length < 40) return '';
                    if (text.length > 650) text = text.substring(0, 647) + '...';
                    return text;
                }).catch(function() { return ''; });
            }
            return doRequest(year).then(function(t) {
                if (t) return t;
                if (year) return doRequest(null);
                return '';
            });
        }

        // Letterboxd: solo se usa como última opción (después de Wiki y OMDb); requiere letterboxdLink en CSV.
        function tryLetterboxdSynopsis(letterboxdUrl) {
            if (!letterboxdUrl || !letterboxdUrl.trim()) return Promise.resolve('');
            var url = letterboxdUrl.trim();
            if (url.indexOf('letterboxd.com') === -1) return Promise.resolve('');
            var proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
            return fetch(proxy)
                .then(function(r) { return r.text(); })
                .then(function(html) {
                    var m = html.match(/<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']/i) ||
                             html.match(/<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:description["\']/i);
                    if (!m || !m[1]) return '';
                    var text = m[1].trim().replace(/\s+/g, ' ');
                    if (text.length < 50) return '';
                    if (text.length > 600) text = text.substring(0, 597) + '...';
                    return text;
                })
                .catch(function() { return ''; });
        }

        // Un solo detalle TMDB (en-US): la misma respuesta trae poster_path y overview. Sinopsis = mismo lugar que el póster.
        function loadPosterFromTMDB(title, year, posterElement) {
            const cacheKey = (title + '|' + year).toLowerCase();
            if (tmdbCache[cacheKey]) {
                const c = tmdbCache[cacheKey];
                var fromLink = posterElement && posterElement.dataset.posterSource === 'link';
                if (!fromLink) {
                    if (c.posterUrl) {
                        posterElement.style.backgroundImage = 'url(' + c.posterUrl + ')';
                        posterElement.classList.add('loaded');
                    } else {
                        setMoviePlaceholder(posterElement, title, year, 'tmdb-no-poster');
                    }
                }
                var syn = c.synopsis && c.synopsis.trim();
                posterElement.setAttribute('data-synopsis', syn || fallbackSynopsisText(posterElement, title, year));
                return;
            }
            function doFetch() {
                var posterFromLink = posterElement && posterElement.dataset.posterSource === 'link';
                const key = typeof CONFIG !== 'undefined' ? CONFIG.TMDB_API_KEY : '';
                if (!key) {
                    if (!posterFromLink) setMoviePlaceholder(posterElement, title, year, 'no-api-key');
                    posterElement.setAttribute('data-synopsis', fallbackSynopsisText(posterElement, title, year));
                    return;
                }
                const base = typeof CONFIG !== 'undefined' ? CONFIG.TMDB_BASE_URL : 'https://api.themoviedb.org/3';
                const imgBase = typeof CONFIG !== 'undefined' ? CONFIG.TMDB_IMAGE_BASE : 'https://image.tmdb.org/t/p';
                var letterboxdUrl = (posterElement && posterElement.dataset.letterboxd) ? posterElement.dataset.letterboxd : '';
                function notFoundTryWikiAndLetterboxd() {
                    var synDefault = fallbackSynopsisText(posterElement, title, year);
                    tmdbCache[cacheKey] = { posterUrl: null, synopsis: synDefault };
                    if (!posterFromLink) setMoviePlaceholder(posterElement, title, year, 'not-found');
                    if (posterElement) posterElement.setAttribute('data-synopsis', synDefault);
                    return tryWikipediaSynopsis(title, year).then(function(wiki) {
                        if (wiki) {
                            tmdbCache[cacheKey].synopsis = wiki;
                            if (posterElement) posterElement.setAttribute('data-synopsis', wiki);
                            return { synopsis: wiki };
                        }
                        return tryOMDbSynopsis(title, year).then(function(omdb) {
                            if (omdb) {
                                var syn = omdb + ' (en inglés)';
                                tmdbCache[cacheKey].synopsis = syn;
                                if (posterElement) posterElement.setAttribute('data-synopsis', syn);
                                return { synopsis: syn };
                            }
                            return tryLetterboxdSynopsis(letterboxdUrl).then(function(lb) {
                                if (lb) {
                                    tmdbCache[cacheKey].synopsis = lb;
                                    if (posterElement) posterElement.setAttribute('data-synopsis', lb);
                                    return { synopsis: lb };
                                }
                                return { synopsis: synDefault };
                            });
                        });
                    });
                }
                let url = base + '/search/movie?api_key=' + key + '&query=' + encodeURIComponent(title) + '&language=es-ES';
                if (year) url += '&year=' + year;
                fetch(url)
                    .then(r => r.json())
                    .then(data => {
                        var results = data.results || [];
                        var match = results[0];
                        if (!match || !match.id) {
                            if (year) {
                                return fetch(base + '/search/movie?api_key=' + key + '&query=' + encodeURIComponent(title) + '&language=es-ES')
                                    .then(r2 => r2.json())
                                    .then(data2 => {
                                        var r2 = data2.results || [];
                                        match = r2[0];
                                        if (!match || !match.id) {
                                            return notFoundTryWikiAndLetterboxd();
                                        }
                                        return { match: match };
                                    });
                            }
                            return notFoundTryWikiAndLetterboxd();
                        }
                        return { match: match };
                    })
                    .then(function(matchResult) {
                        if (!matchResult || !matchResult.match) return null;
                        var match = matchResult.match;
                        var detailUrl = base + '/movie/' + match.id + '?api_key=' + key + '&language=es-ES';
                        return fetch(detailUrl).then(function(r) { return r.json(); }).then(function(detail) {
                            if (!detail || !detail.id) {
                                var fb = fallbackSynopsisText(posterElement, title, year);
                                tmdbCache[cacheKey] = { posterUrl: null, synopsis: fb };
                                if (!posterFromLink) setMoviePlaceholder(posterElement, title, year, 'tmdb-error');
                                if (posterElement) posterElement.setAttribute('data-synopsis', fb);
                                return { detail: null, synopsis: fb };
                            }
                            var posterPath = detail.poster_path;
                            var posterUrl = posterPath ? (imgBase + '/w500' + posterPath) : null;
                            var overview = (detail.overview && typeof detail.overview === 'string') ? detail.overview.trim() : '';
                            var titleForPlaceholder = detail.title || title;
                            var yearForPlaceholder = detail.release_date ? String(detail.release_date).slice(0, 4) : year;
                            var synopsisToShow = overview || fallbackSynopsisText(posterElement, title, year);
                            tmdbCache[cacheKey] = { posterUrl: posterUrl, synopsis: synopsisToShow };
                            if (posterElement) {
                                if (!posterFromLink) {
                                    if (posterUrl) {
                                        posterElement.style.backgroundImage = 'url(' + posterUrl + ')';
                                        posterElement.classList.add('loaded');
                                    } else {
                                        setMoviePlaceholder(posterElement, titleForPlaceholder, yearForPlaceholder, 'no-poster');
                                    }
                                }
                                posterElement.setAttribute('data-synopsis', synopsisToShow);
                            }
                            if (overview) {
                                return Promise.resolve({ detail: detail, synopsis: synopsisToShow });
                            }
                            return fetch(base + '/movie/' + match.id + '?api_key=' + key + '&language=en-US').then(function(r) { return r.json(); }).then(function(detailEn) {
                                var overviewEn = (detailEn && detailEn.overview && typeof detailEn.overview === 'string') ? detailEn.overview.trim() : '';
                                if (overviewEn) {
                                    var syn = overviewEn + ' (en inglés)';
                                    tmdbCache[cacheKey].synopsis = syn;
                                    if (posterElement) posterElement.setAttribute('data-synopsis', syn);
                                    return Promise.resolve({ detail: detail, synopsis: syn });
                                }
                                return tryWikipediaSynopsis(title, year).then(function(wiki) {
                                if (wiki) {
                                    tmdbCache[cacheKey].synopsis = wiki;
                                    if (posterElement) posterElement.setAttribute('data-synopsis', wiki);
                                    return { detail: detail, synopsis: wiki };
                                }
                                return tryOMDbSynopsis(title, year).then(function(omdb) {
                                    var syn = omdb ? (omdb + ' (en inglés)') : synopsisToShow;
                                    if (omdb) {
                                        tmdbCache[cacheKey].synopsis = syn;
                                        if (posterElement) posterElement.setAttribute('data-synopsis', syn);
                                        return { detail: detail, synopsis: syn };
                                    }
                                    return tryLetterboxdSynopsis(letterboxdUrl).then(function(lb) {
                                        if (lb) {
                                            tmdbCache[cacheKey].synopsis = lb;
                                            if (posterElement) posterElement.setAttribute('data-synopsis', lb);
                                            return { detail: detail, synopsis: lb };
                                        }
                                        return { detail: detail, synopsis: synopsisToShow };
                                    });
                                });
                            });
                            }).catch(function() { return tryWikipediaSynopsis(title, year).then(function(wiki) {
                                if (wiki) {
                                    tmdbCache[cacheKey].synopsis = wiki;
                                    if (posterElement) posterElement.setAttribute('data-synopsis', wiki);
                                    return { detail: detail, synopsis: wiki };
                                }
                                return tryOMDbSynopsis(title, year).then(function(omdb) {
                                    var syn = omdb ? (omdb + ' (en inglés)') : synopsisToShow;
                                    if (omdb) {
                                        tmdbCache[cacheKey].synopsis = syn;
                                        if (posterElement) posterElement.setAttribute('data-synopsis', syn);
                                        return { detail: detail, synopsis: syn };
                                    }
                                    return tryLetterboxdSynopsis(letterboxdUrl).then(function(lb) {
                                        if (lb) {
                                            tmdbCache[cacheKey].synopsis = lb;
                                            if (posterElement) posterElement.setAttribute('data-synopsis', lb);
                                            return { detail: detail, synopsis: lb };
                                        }
                                        return { detail: detail, synopsis: synopsisToShow };
                                    });
                                });
                            }); }).then(function(res) { return res; });
                        }).catch(function() {
                            var syn = fallbackSynopsisText(posterElement, title, year);
                            tmdbCache[cacheKey] = { posterUrl: null, synopsis: syn };
                            if (posterElement) posterElement.setAttribute('data-synopsis', syn);
                            return { detail: null, synopsis: syn };
                        });
                    })
                    .then(function(data) {
                        if (!data) return;
                        if (posterElement && data.synopsis) posterElement.setAttribute('data-synopsis', data.synopsis);
                    })
                    .catch(err => {
                        var fallback = fallbackSynopsisText(posterElement, title, year);
                        tmdbCache[cacheKey] = { posterUrl: null, synopsis: fallback };
                        if (!posterFromLink) setMoviePlaceholder(posterElement, title, year, 'tmdb-error');
                        if (posterElement) posterElement.setAttribute('data-synopsis', fallback);
                    });
            }
            doFetch();
        }

        document.querySelector('.loading-overlay').classList.add('visible');

        window.onload = function() {
            fetch(CONFIG.CSV_URL)
                .then(response => response.text())
                .then(csvData => {
                    Papa.parse(csvData, {
                        complete: function(results) {
                            movieData = results.data.map(row => ({
                                title: row[0],
                                director: row[1],
                                year: parseInt(row[2]),
                                duration: row[3] ? row[3].trim() : null,
                                movieLink: row[4],
                                letterboxdLink: row[5],
                                tags: row[6] ? row[6].split(',').map(tag => tag.trim()) : [],
                                posterLink: row[7] ? row[7].trim() : '', // NUEVO: columna H
                                isNew: isNewMovie(row[0])
                            }));
                            shuffleArray(movieData);
                            renderTable(movieData);
                            renderGallery(movieData);
                            // Mostrar galería como principal
                            switchView('gallery');
                            setTimeout(() => {
                                document.querySelector('.loading-overlay').classList.remove('visible');
                            }, 500);
                        },
                        header: false,
                        skipEmptyLines: true
                    });
                })
                .catch(error => {
                    console.error("Error al cargar el archivo CSV:", error);
                    document.querySelector('.loading-overlay').classList.remove('visible');
                });
        };

        function switchView(view) {
            currentView = view;
            // Actualizar botones
            document.getElementById('tableViewBtn').classList.toggle('active', view === 'table');
            document.getElementById('galleryViewBtn').classList.toggle('active', view === 'gallery');
            // Mostrar/ocultar vistas
            document.getElementById('tableView').style.display = view === 'table' ? 'block' : 'none';
            document.getElementById('galleryView').style.display = view === 'gallery' ? 'block' : 'none';
            // Aplicar el filtro actual al cambiar de vista
            applyCurrentFilter();
        }

        function applyCurrentFilter() {
            let filtered = movieData;
            if (currentFilter.type === 'search') {
                const query = currentFilter.value;
                filtered = movieData.filter(movie =>
                    movie.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query) ||
                    movie.director.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query) ||
                    movie.year.toString().includes(query) ||
                    movie.tags.some(tag => tag.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query))
                );
            } else if (currentFilter.type === 'director') {
                const searchDirector = currentFilter.value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                filtered = movieData.filter(movie => {
                    const movieDirectors = movie.director
                        .split(/\s+[y&,]\s+|\s*,\s*/g)
                        .map(d => d.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
                        .filter(d => d !== '');
                    return movieDirectors.includes(searchDirector);
                });
            } else if (currentFilter.type === 'year') {
                filtered = movieData.filter(m => m.year === currentFilter.value);
            } else if (currentFilter.type === 'tag') {
                filtered = movieData.filter(movie => movie.tags.includes(currentFilter.value));
            }
            renderTable(filtered);
            renderGallery(filtered);
        }

        function renderGallery(movies) {
            filteredMovies = movies;
            currentPage = 1;
            updateGallery();
            // Mostrar botón 'Volver' si la galería está filtrada
            const resetButton = document.getElementById('resetButton');
            if (movies.length !== movieData.length) {
                resetButton.style.display = 'inline';
            } else {
                resetButton.style.display = 'none';
            }
        }

        function updateGallery() {
            const galleryGrid = document.getElementById('galleryGrid');
            const paginationDiv = document.getElementById('galleryPagination');
            
            if (filteredMovies.length === 0) {
                galleryGrid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #666;">
                        <div style="font-size: 16px;">
                            No encontramos lo que estabas buscando 😕
                            <br>
                            <button onclick="resetTable()" style="margin-top: 15px; padding: 8px 15px; background: #8ac0ff; border: none; color: white; border-radius: 4px; cursor: pointer;">
                                Ver todas las películas
                            </button>
                        </div>
                    </div>
                `;
                paginationDiv.style.display = 'none';
                return;
            }

            const totalPages = Math.ceil(filteredMovies.length / moviesPerPage);
            const startIndex = (currentPage - 1) * moviesPerPage;
            const endIndex = startIndex + moviesPerPage;
            const currentMovies = filteredMovies.slice(startIndex, endIndex);

            // Inicializar estadísticas para esta página
            posterStats.total = currentMovies.length;
            posterStats.loaded = 0;
            posterStats.failed = 0;
            posterStats.pending = currentMovies.length;

            // Mostrar loading mientras se cargan los posters
            galleryGrid.innerHTML = `
                <div class="gallery-loading" style="grid-column: 1 / -1;">
                    <div class="loading-spinner"></div>
                    <div>Cargando posters... (0/${currentMovies.length})</div>
                </div>
            `;

            // Renderizar las películas de la página actual
            setTimeout(() => {
                galleryGrid.innerHTML = '';
                
                currentMovies.forEach((movie, index) => {
                    const card = document.createElement('div');
                    card.className = 'movie-card';
                    
                    const newBadge = movie.isNew ? '<div class="new-badge">NUEVO</div>' : '';
                    
                    card.innerHTML = `
                        ${newBadge}
                        <div class="movie-poster" data-letterboxd="${movie.letterboxdLink}"></div>
                        <div class="movie-info">
                            <div class="movie-title">${movie.title}</div>
                            <div class="movie-meta">
                                <span class="movie-year">${movie.year}</span>
                                ${movie.duration ? ` • ${movie.duration}'` : ''}
                            </div>
                            <div class="movie-director">${movie.director}</div>
                            <div class="movie-tags">
                                ${movie.tags.slice(0, 3).map(tag => `<span class="movie-tag">${tag}</span>`).join('')}
                                ${movie.tags.length > 3 ? `<span class="movie-tag">+${movie.tags.length - 3}</span>` : ''}
                            </div>
                            <div class="movie-actions">
                                <a href="${movie.movieLink}" target="_blank">Ver</a>
                                <a href="${movie.letterboxdLink}" target="_blank">Letterboxd</a>
                            </div>
                        </div>
                    `;
                    
                    // Agregar evento click para abrir popup
                    card.addEventListener('click', (e) => {
                        // Evitar que se abra si se hace click en los enlaces
                        if (e.target.tagName === 'A') return;
                        showMoviePopup(movie, card);
                    });
                    
                    galleryGrid.appendChild(card);
                    
                    // Datos en la tarjeta; una sola ruta de carga (processPosterQueue) para no duplicar peticiones
                    const posterDiv = card.querySelector('.movie-poster');
                    posterDiv.dataset.movieTitle = movie.title;
                    posterDiv.dataset.movieYear = movie.year;
                    posterDiv.dataset.movieDirector = movie.director || '';
                    posterDiv.dataset.posterLink = movie.posterLink || '';
                    posterDiv.dataset.letterboxd = movie.letterboxdLink || '';
                    posterDiv.dataset.loaded = '0';
                    registerPosterForLazyLoad(posterDiv);
                    processPosterQueue(posterDiv);
                });

                // Actualizar paginación
                updatePagination(totalPages);
            }, 300);
        }

        function updatePagination(totalPages) {
            const paginationDiv = document.getElementById('galleryPagination');
            const pageInfo = document.getElementById('pageInfo');
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            const gotoInput = document.getElementById('gotoPageInput');
            const gotoLabel = document.getElementById('gotoLabel');

            if (totalPages <= 1) {
                paginationDiv.style.display = 'none';
                gotoInput.style.display = 'none';
                gotoLabel.style.display = 'none';
                return;
            }

            paginationDiv.style.display = 'flex';
            pageInfo.textContent = `Página ${currentPage} de ${totalPages}`;
            prevBtn.disabled = currentPage === 1;
            nextBtn.disabled = currentPage === totalPages;
            gotoInput.value = currentPage;
            gotoInput.style.display = 'inline-block';
            gotoLabel.style.display = 'inline-block';
            gotoInput.max = totalPages;
        }

        function changePage(direction) {
            const totalPages = Math.ceil(filteredMovies.length / moviesPerPage);
            const newPage = currentPage + direction;
            
            if (newPage >= 1 && newPage <= totalPages) {
                currentPage = newPage;
                updateGallery();
                
                // Scroll suave hacia arriba de la galería
                document.getElementById('galleryView').scrollIntoView({ 
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        }

        function gotoGalleryPage() {
            const input = document.getElementById('gotoPageInput');
            const totalPages = Math.ceil(filteredMovies.length / moviesPerPage);
            let page = parseInt(input.value);
            if (isNaN(page) || page < 1) page = 1;
            if (page > totalPages) page = totalPages;
            currentPage = page;
            updateGallery();
        }

        function setMoviePlaceholder(element, title, year, reason) {
            console.log('🎨 Usando placeholder personalizado para:', title, 'Motivo:', reason || 'desconocido');
            
            // Crear un placeholder más atractivo con información de la película
            element.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            element.style.backgroundSize = 'cover';
            element.style.backgroundPosition = 'center';
            element.style.display = 'flex';
            element.style.alignItems = 'center';
            element.style.justifyContent = 'center';
            element.style.color = 'white';
            element.style.fontSize = '14px';
            element.style.fontWeight = 'bold';
            element.style.textAlign = 'center';
            element.style.padding = '20px';
            element.style.boxSizing = 'border-box';
            element.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
            
            // Agregar texto con información de la película (sin información técnica)
            element.innerHTML = `
                <div>
                    <div style="font-size: 16px; margin-bottom: 8px;">${title}</div>
                    <div style="font-size: 12px; opacity: 0.9;">${year}</div>
                    <div style="font-size: 10px; opacity: 0.7; margin-top: 8px;">🎬</div>
                </div>
            `;
            
            element.classList.add('loaded');
        }

        function setPlaceholderPoster(element) {
            element.style.backgroundImage = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            element.style.backgroundSize = 'cover';
            element.style.backgroundPosition = 'center';
            element.classList.add('loaded');
        }

        function isNewMovie(title) {
            const newMovies = new Set(['Película Nueva 1', 'Película Nueva 2']);
            return newMovies.has(title);
        }

        function handleColumnClick(column) {
            event.preventDefault();
            
            if (currentSort.column === column) {
                currentSort.clicks++;
                if (currentSort.clicks === 3) {
                    currentSort.clicks = 0;
                    currentSort.column = null;
                    renderTable(movieData);
                    if (currentView === 'gallery') {
                        renderGallery(movieData);
                    }
                    return;
                }
                currentSort.ascending = !currentSort.ascending;
            } else {
                currentSort.column = column;
                currentSort.ascending = true;
                currentSort.clicks = 1;
            }

            let sortedMovies = [...movieData];
            
            switch (column) {
                case 'title':
                    sortedMovies.sort((a, b) => {
                        return currentSort.ascending ? 
                            a.title.localeCompare(b.title) : 
                            b.title.localeCompare(a.title);
                    });
                    break;
                case 'director':
                    sortedMovies.sort((a, b) => {
                        return currentSort.ascending ? 
                            a.director.localeCompare(b.director) : 
                            b.director.localeCompare(a.director);
                    });
                    break;
                case 'year':
                    sortedMovies.sort((a, b) => {
                        return currentSort.ascending ? a.year - b.year : b.year - a.year;
                    });
                    break;
                case 'duration':
                    sortedMovies.sort((a, b) => {
                        const durationA = a.duration ? parseInt(a.duration) : 0;
                        const durationB = b.duration ? parseInt(b.duration) : 0;
                        return currentSort.ascending ? durationA - durationB : durationB - durationA;
                    });
                    break;
            }

            updateSortArrows(column);
            renderTable(sortedMovies);
            if (currentView === 'gallery') {
                renderGallery(sortedMovies);
            }
        }

        function updateSortArrows(column) {
            const headers = document.querySelectorAll('th.sortable');
            headers.forEach(header => {
                header.classList.remove('sort-asc', 'sort-desc');
                const headerText = header.textContent.toLowerCase();
                if (headerText.includes(column) || 
                    (column === 'title' && headerText.includes('película'))) {
                    header.classList.add(currentSort.ascending ? 'sort-asc' : 'sort-desc');
                }
            });
        }

        function renderTable(movies) {
            const tableBody = document.querySelector('#movieTable tbody');
            tableBody.innerHTML = '';
            
            if (movies.length === 0) {
                const noResultsRow = document.createElement('tr');
                noResultsRow.innerHTML = `
                    <td colspan="7" style="text-align: center; padding: 40px;">
                        <div style="color: #666; font-size: 16px;">
                            No encontramos lo que estabas buscando 😕
                            <br>
                            <button onclick="resetTable()" style="margin-top: 15px; padding: 8px 15px; background: #8ac0ff; border: none; color: white; border-radius: 4px; cursor: pointer;">
                                Ver todas las películas
                            </button>
                        </div>
                    </td>
                `;
                tableBody.appendChild(noResultsRow);
                return;
            }
            
            movies.forEach((movie, index) => {
                const row = document.createElement('tr');
                const movieClass = movie.isNew ? 'new-movie' : '';
                const tagsHtml = movie.tags.map(tag => 
                    `<a href="#" class="tag-link" onclick="filterByTag('${tag}')">${tag}</a>`
                ).join(' ');
                
                row.innerHTML = `
                    <td class="${movieClass}">${movie.title}</td>
                    <td><a href="#" class="year-link" onclick="filterByYear(${movie.year})">${movie.year}</a></td>
                    <td>${movie.duration ? movie.duration + "'" : ''}</td>
                    <td>${formatDirectors(movie.director)}</td>
                    <td>${tagsHtml}</td>
                    <td><a href="${movie.movieLink}" class="movie-link" target="_blank">Ver</a></td>
                    <td><a href="${movie.letterboxdLink}" class="letterboxd-link" target="_blank">Letterboxd</a></td>
                `;
                tableBody.appendChild(row);
            });
        }

        let searchMoviesDebouncedTimer = null;
        function searchMoviesDebounced() {
            clearTimeout(searchMoviesDebouncedTimer);
            searchMoviesDebouncedTimer = setTimeout(searchMovies, typeof CONFIG !== 'undefined' ? CONFIG.SEARCH_DEBOUNCE_MS : 300);
        }

        function searchMovies() {
            const query = (document.getElementById('searchInput').value || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            currentFilter = { type: 'search', value: query };
            const filteredMovies = movieData.filter(movie =>
                movie.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query) ||
                movie.director.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query) ||
                movie.year.toString().includes(query) ||
                movie.tags.some(tag => tag.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(query))
            );
            renderTable(filteredMovies);
            if (currentView === 'gallery') {
                renderGallery(filteredMovies);
            }
            // El botón 'Volver' ahora se maneja en renderGallery
        }

        function filterByTag(tag) {
            event.preventDefault();
            currentFilter = { type: 'tag', value: tag };
            const filteredMovies = movieData.filter(movie => movie.tags.includes(tag));
            renderTable(filteredMovies);
            if (currentView === 'gallery') {
                renderGallery(filteredMovies);
            }
            // El botón 'Volver' ahora se maneja en renderGallery
        }

        function openRandomMovie() {
            if (movieData.length > 0) {
                const randomIndex = Math.floor(Math.random() * movieData.length);
                const randomMovie = movieData[randomIndex];
                window.open(randomMovie.movieLink, '_blank');
            }
        }

        function showInfo() {
            const popup = document.getElementById('infoPopup');
            popup.style.display = 'flex';
            setTimeout(() => popup.classList.add('visible'), 10);
        }

        function closeInfo() {
            const popup = document.getElementById('infoPopup');
            popup.classList.remove('visible');
            setTimeout(() => popup.style.display = 'none', 300);
        }

        let _popupEscHandler = null;

        function showMoviePopup(movie, card) {
            const popup = document.getElementById('moviePopup');
            const posterImg = card.querySelector('.movie-poster');
            var synopsis = (posterImg.getAttribute('data-synopsis') || '').trim();
            if (!synopsis || synopsis === 'Sinopsis no disponible.') {
                var ck = (movie.title + '|' + (movie.year || '')).toLowerCase();
                if (typeof tmdbCache !== 'undefined' && tmdbCache[ck] && tmdbCache[ck].synopsis)
                    synopsis = tmdbCache[ck].synopsis.trim();
            }
            if (!synopsis || synopsis === 'Sinopsis no disponible.') {
                loadPosterFromTMDB(movie.title, movie.year, posterImg);
                synopsis = (posterImg.getAttribute('data-synopsis') || '').trim();
            }
            if (!synopsis || synopsis === 'Sinopsis no disponible.')
                synopsis = (movie.year ? 'Película de ' + movie.year + '.' : '') + (movie.director ? ' Dirigida por ' + movie.director + '.' : '') + ' Sinopsis no disponible en las fuentes.';
            if (!synopsis.trim()) synopsis = 'Sinopsis no disponible.';

            document.querySelector('.movie-popup-title').textContent = movie.title;
            document.querySelector('.movie-popup-year').innerHTML = `<a href="#" class="popup-link-year">${movie.year}</a>`;
            document.querySelector('.movie-popup-duration').innerHTML = movie.duration ? `<a href="#" style="text-decoration:none;cursor:default;">${movie.duration}'</a>` : '';
            document.querySelector('.movie-popup-director').innerHTML = `<a href="#" class="popup-link-director">${movie.director}</a>`;
            document.querySelector('.synopsis-text').textContent = synopsis;
            
            const popupPosterImg = document.querySelector('.movie-popup-poster-img');
            if (posterImg.style.backgroundImage) {
                popupPosterImg.style.backgroundImage = posterImg.style.backgroundImage;
            } else {
                popupPosterImg.style.backgroundImage = 'none';
                popupPosterImg.style.backgroundColor = '#f0f0f0';
            }
            
            document.querySelector('.movie-popup-watch').href = movie.movieLink;
            document.querySelector('.movie-popup-letterboxd').href = movie.letterboxdLink;
            
            setTimeout(() => {
                document.querySelector('.popup-link-year').onclick = function(e) {
                    e.preventDefault();
                    closeMoviePopup();
                    filterGalleryByYear(movie.year);
                };
                document.querySelector('.popup-link-director').onclick = function(e) {
                    e.preventDefault();
                    closeMoviePopup();
                    filterGalleryByDirector(movie.director);
                };
            }, 10);
            
            popup.style.display = 'flex';
            setTimeout(() => popup.classList.add('visible'), 10);

            _popupEscHandler = function(e) {
                if (e.key === 'Escape') {
                    closeMoviePopup();
                }
            };
            document.addEventListener('keydown', _popupEscHandler);
        }

        function filterGalleryByYear(year) {
            currentFilter = { type: 'year', value: year };
            const filtered = movieData.filter(m => m.year === year);
            renderGallery(filtered);
            document.getElementById('resetButton').style.display = 'inline';
        }
        function filterGalleryByDirector(director) {
            currentFilter = { type: 'director', value: director };
            const filtered = movieData.filter(m => m.director === director);
            renderGallery(filtered);
            document.getElementById('resetButton').style.display = 'inline';
        }

        function closeMoviePopup() {
            if (_popupEscHandler) {
                document.removeEventListener('keydown', _popupEscHandler);
                _popupEscHandler = null;
            }
            const popup = document.getElementById('moviePopup');
            popup.classList.remove('visible');
            setTimeout(() => popup.style.display = 'none', 300);
        }

        function formatDirectors(directors) {
            return directors
                .split(/\s+[y&,]\s+|\s*,\s*/g)
                .filter(director => director.trim() !== '')
                .map(director => {
                    const cleanDirector = director.trim();
                    return `<a href="#" class="director-link" onclick="filterByDirector('${cleanDirector}')">${cleanDirector}</a>`;
                })
                .join(' y ');
        }

        function filterByDirector(director) {
            event.preventDefault();
            currentFilter = { type: 'director', value: director };
            const filteredMovies = movieData.filter(movie => {
                const movieDirectors = movie.director
                    .split(/\s+[y&,]\s+|\s*,\s*/g)
                    .map(d => d.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
                    .filter(d => d !== '');
                const searchDirector = director.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                return movieDirectors.includes(searchDirector);
            });
            renderTable(filteredMovies);
            if (currentView === 'gallery') {
                renderGallery(filteredMovies);
            }
            // El botón 'Volver' ahora se maneja en renderGallery
        }

        function filterByYear(year) {
            event.preventDefault();
            const filteredMovies = movieData.filter(movie => movie.year === year);
            renderTable(filteredMovies);
            if (currentView === 'gallery') {
                renderGallery(filteredMovies);
            }
            document.getElementById('resetButton').style.display = 'inline';
        }

        function resetTable() {
            document.getElementById('searchInput').value = '';
            currentFilter = { type: null, value: null };
            renderTable(movieData);
            if (currentView === 'gallery') {
                renderGallery(movieData);
            }
            document.getElementById('resetButton').style.display = 'none';
            currentSort.column = null;
            currentSort.clicks = 0;
            updateSortArrows(null);
        }

        function resetGallery() {
            renderGallery(movieData);
        }

        function shuffleArray(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        }

        function debugPosters() {
            console.log('Debugging posters...');
            if (currentView === 'gallery') {
                const movieCards = document.querySelectorAll('.movie-card');
                movieCards.forEach((card, index) => {
                    const posterDiv = card.querySelector('.movie-poster');
                    const title = posterDiv.dataset.movieTitle;
                    const year = posterDiv.dataset.movieYear;
                    if (title && posterDiv.dataset.loaded !== '1') {
                        posterDiv.dataset.loaded = '0';
                        loadPosterFromTMDB(title, year, posterDiv);
                    }
                });
            } else {
                console.log('Cambia a vista de galería para debuggear posters');
            }
        }

        function testLetterboxdUrls() {
            console.log('=== PRUEBA DE URLs DE LETTERBOXD ===');
            // Probar con una película conocida
            const testUrls = [
                'https://a.ltrbxd.com/resized/film-poster/parasite-2019-0-600-0-900-crop.jpg',
                'https://a.ltrbxd.com/resized/film-poster/the-shawshank-redemption-0-600-0-900-crop.jpg',
                'https://a.ltrbxd.com/resized/film-poster/pulp-fiction-0-600-0-900-crop.jpg'
            ];
        }

        function closeMobileMenu() {
            document.getElementById('mobileMenu').classList.remove('open');
            document.getElementById('mobileMenuBg').classList.remove('open');
        }
        function openMobileMenu() {
            document.getElementById('mobileMenu').classList.add('open');
            document.getElementById('mobileMenuBg').classList.add('open');
        }
        // Mostrar/ocultar menú hamburguesa según tamaño
        function handleResizeMenu() {
            if(window.innerWidth <= 600) {
                document.getElementById('hamburgerBtn').style.display = 'block';
                document.querySelector('.header-buttons').style.display = 'none';
                document.getElementById('mobileMenu').style.display = '';
                document.getElementById('mobileMenuBg').style.display = '';
            } else {
                document.getElementById('hamburgerBtn').style.display = 'none';
                document.querySelector('.header-buttons').style.display = 'flex';
                document.getElementById('mobileMenu').style.display = 'none';
                document.getElementById('mobileMenuBg').style.display = 'none';
                closeMobileMenu();
            }
        }
        window.addEventListener('resize', handleResizeMenu);
        window.addEventListener('DOMContentLoaded', handleResizeMenu);
        document.getElementById('hamburgerBtn').onclick = openMobileMenu;
        document.getElementById('mobileMenuBg').onclick = closeMobileMenu;
        // Cerrar menú al elegir opción (ya está en el onclick de cada botón)

        // Renderizar tarjetas de lista en móvil
        function renderMobileListCards(movies) {
          const tableView = document.getElementById('tableView');
          let cardsDiv = tableView.querySelector('.mobile-list-cards');
          if (!cardsDiv) {
            cardsDiv = document.createElement('div');
            cardsDiv.className = 'mobile-list-cards';
            tableView.appendChild(cardsDiv);
          }
          cardsDiv.innerHTML = '';
          movies.forEach(movie => {
            const card = document.createElement('div');
            card.className = 'mobile-list-card';
            card.innerHTML = `
              <div class="ml-main">
                <div class="ml-title">${movie.title}</div>
                <div class="ml-meta">${movie.year}${movie.duration ? " • " + movie.duration + "'" : ''}</div>
                <div class="ml-meta">${movie.director}</div>
                <div class="ml-meta">${movie.tags.slice(0, 3).map(tag => `<span class='movie-tag'>${tag}</span>`).join('')}</div>
              </div>
              <div class="ml-actions">
                <a href="${movie.movieLink}" target="_blank">Ver</a>
                <a href="${movie.letterboxdLink}" target="_blank">Letterboxd</a>
              </div>
            `;
            cardsDiv.appendChild(card);
          });
        }

        // Llamar a renderMobileListCards cuando se renderiza la tabla
        const originalRenderTable = renderTable;
        renderTable = function(movies) {
          const tableBody = document.querySelector('#movieTable tbody');
          tableBody.innerHTML = '';
          movies.forEach((movie, index) => {
            const row = document.createElement('tr');
            const movieClass = movie.isNew ? 'new-movie' : '';
            const tagsHtml = movie.tags.map(tag => 
              `<a href=\"#\" class=\"tag-link\" onclick=\"filterByTag('${tag}')\">${tag}</a>`
            ).join(' ');
            row.innerHTML = `
              <td class="${movieClass}">${movie.title}</td>
              <td><a href=\"#\" class=\"year-link\" onclick=\"filterByYear(${movie.year})\">${movie.year}</a></td>
              <td>${movie.duration ? movie.duration + "'" : ''}</td>
              <td>${formatDirectors(movie.director)}</td>
              <td>${tagsHtml}</td>
              <td><a href="${movie.movieLink}" class="movie-link" target="_blank">Ver</a></td>
              <td><a href="${movie.letterboxdLink}" class="letterboxd-link" target="_blank">Letterboxd</a></td>
            `;
            tableBody.appendChild(row);
          });
          // NUEVO: renderizar tarjetas para móvil
          renderMobileListCards(movies);
        }

        function applyGalleryOrder() {
            let select = document.getElementById('galleryOrderSelectDesktop');
            if (window.innerWidth <= 600) {
                select = document.getElementById('galleryOrderSelectMobile');
            }
            const value = select.value;
            let movies = filteredMovies.length ? [...filteredMovies] : [...movieData];
            switch (value) {
                case 'az-title':
                    movies.sort((a, b) => a.title.localeCompare(b.title));
                    break;
                case 'az-director':
                    movies.sort((a, b) => a.director.localeCompare(b.director));
                    break;
                case 'year-asc':
                    movies.sort((a, b) => a.year - b.year);
                    break;
                case 'year-desc':
                    movies.sort((a, b) => b.year - a.year);
                    break;
                case 'duration-asc':
                    movies.sort((a, b) => {
                        const dA = a.duration ? parseInt(a.duration) : 0;
                        const dB = b.duration ? parseInt(b.duration) : 0;
                        return dA - dB;
                    });
                    break;
                case 'duration-desc':
                    movies.sort((a, b) => {
                        const dA = a.duration ? parseInt(a.duration) : 0;
                        const dB = b.duration ? parseInt(b.duration) : 0;
                        return dB - dA;
                    });
                    break;
            }
            renderGallery(movies);
        }

        // MODO OSCURO
        function setDarkMode(enabled) {
            if (enabled) {
                document.body.classList.add('dark-mode');
                document.getElementById('darkModeBtn').textContent = '☀️ Claro';
                var btnMobile = document.getElementById('darkModeBtnMobile');
                if(btnMobile) btnMobile.textContent = '☀️ Claro';
                localStorage.setItem('darkMode', '1');
            } else {
                document.body.classList.remove('dark-mode');
                document.getElementById('darkModeBtn').textContent = '🌙 Oscuro';
                var btnMobile = document.getElementById('darkModeBtnMobile');
                if(btnMobile) btnMobile.textContent = '🌙 Oscuro';
                localStorage.setItem('darkMode', '0');
            }
        }
        function toggleDarkMode() {
            const isDark = document.body.classList.contains('dark-mode');
            setDarkMode(!isDark);
        }
        // Al cargar la página, aplicar preferencia guardada
        window.addEventListener('DOMContentLoaded', function() {
            const darkPref = localStorage.getItem('darkMode');
            setDarkMode(darkPref === '1');
        });

        // Opciones completas y abreviadas para el select móvil
        const filterOptionsFull = [
            { value: 'az-title', text: 'Orden alfabético por película (A-Z)' },
            { value: 'az-director', text: 'Orden alfabético por director (A-Z)' },
            { value: 'year-asc', text: 'Año (ascendente)' },
            { value: 'year-desc', text: 'Año (descendente)' },
            { value: 'duration-asc', text: 'Duración (ascendente)' },
            { value: 'duration-desc', text: 'Duración (descendente)' }
        ];
        const filterOptionsShort = [
            { value: 'az-title', text: '🔽' },
            { value: 'az-director', text: 'Dir' },
            { value: 'year-asc', text: 'A↑' },
            { value: 'year-desc', text: 'A↓' },
            { value: 'duration-asc', text: 'D↑' },
            { value: 'duration-desc', text: 'D↓' }
        ];

        function setMobileFilterOptions(full) {
            const select = document.getElementById('galleryOrderSelectMobile');
            if (!select) return;
            const options = full ? filterOptionsFull : filterOptionsShort;
            const currentValue = select.value;
            select.innerHTML = '';
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                if (opt.value === currentValue) option.selected = true;
                select.appendChild(option);
            });
        }

        document.addEventListener('DOMContentLoaded', function() {
            const select = document.getElementById('galleryOrderSelectMobile');
            if (select) {
                select.addEventListener('focus', function() { setMobileFilterOptions(true); });
                select.addEventListener('blur', function() { setMobileFilterOptions(false); });
            }
        });