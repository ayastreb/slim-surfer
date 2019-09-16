import shouldCompress from './background/shouldCompress'
import patchContentSecurity from './background/patchContentSecurity'
import getHeaderValue from './background/getHeaderIntValue'
import parseUrl from './utils/parseUrl'
import deferredStateStorage from './utils/deferredStateStorage'
import defaultState from './defaults'
import axios from 'axios'

chrome.storage.local.get(storedState => {
    const storage = deferredStateStorage()
    const compressed = new Set();
    let setupOpen
    let state
    let pageUrl
    let isWebpSupported

    if (/compressor\.bandwidth-hero\.com/i.test(storedState.proxyUrl)) {
        chrome.storage.local.set({ ...storedState, proxyUrl: '' })
    }

    setState({ ...defaultState, ...storedState })

    checkWebpSupport().then(isSupported => {
        isWebpSupported = isSupported
        chrome.storage.local.set({ ...storedState, isWebpSupported: isSupported })
    })

    async function checkWebpSupport() {
        if (!self.createImageBitmap) return false

            const webpData = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
            const blob = await fetch(webpData).then(r => r.blob())
            return self.createImageBitmap(blob).then(() => true, () => false)
    }

    /**
     * Sync state.
     */
    function setState(newState) {
        if (!state || state.enabled !== newState.enabled) {
            setIcon(newState.enabled);
        }
        state = newState
        //attach or remove listeners based on state.enabled
        state.enabled ? attachListeners() : detachListeners()
        return true //acknowledge
    }

    /**
     * Sets the icons based on the disabled parameter.
     * @param enabled
     */
    function setIcon(enabled) {
        if (chrome.browserAction.setIcon) {
            chrome.browserAction.setIcon({
                path: enabled ? 'assets/icon-128.png' : 'assets/icon-128-disabled.png'
            })
        }
    }

    /**
     * Checks if the proxy is disabled for the given url
     * @param url
     * @returns {boolean}
     */
    function isDisabledSite(url) {
        const disabledHosts = state && state.disabledHosts || []
        return disabledHosts.includes(url)
    }

    /**
     * refreshState
     */
    function updateState(changes) {
        const changedItems = Object.keys(changes)
        for (const item of changedItems) {
            if( state[item] !== changes[item].newValue){
                state[item] = changes[item].newValue
                if(item === "enabled"){
                    state.enabled ? attachListeners() : detachListeners()
                    setIcon(state.enabled);
                } else if (item === "disabledHosts") {
                    const disabled = isDisabledSite(pageUrl)
                    setIcon(!disabled);
                }
            }
        }
    }

    function checkSetup() {
        if(state.enabled){
            attachListeners()
            if (
                !setupOpen &&
                (state.proxyUrl === '' || /compressor\.bandwidth-hero\.com/i.test(state.proxyUrl))
            ) {
                chrome.tabs.create({ url: 'setup.html' })
                setupOpen = true

            }
        }
    }

    /**
     * Intercept image loading request and decide if we need to compress it.
     */
    function onBeforeRequestListener({ url, documentUrl, type }) {
        checkSetup()

        // Occasionally currentPageUrl is not ready in time on FF
        const pageUrl = currentPageUrl || parseUrl(documentUrl).host;

        if (
            shouldCompress({
                imageUrl: url,
                pageUrl,
                compressed,
                proxyUrl: state.proxyUrl,
                disabledHosts: state.disabledHosts,
                enabled: state.enabled,
                type
            })
        ) {
            compressed.add(url)
            const redirectUrl = buildCompressUrl(url);

            if (!isFirefox()) return { redirectUrl }
            // Firefox allows onBeforeRequest event listener to return a Promise
            // and perform redirect when this Promise is resolved.
            // This allows us to run HEAD request before redirecting to compression
            // to make sure that the image should be compressed.
            return axios.head(url).then(res => {
                if (
                    res.status === 200 &&
                    res.headers['content-length'] > 1024 &&
                    res.headers['content-type'] &&
                    res.headers['content-type'].startsWith('image')
                ) {
                    return { redirectUrl }
                }
            }).catch(error => {
                if(error.response.status === 405)//HEAD method not allowed
                {
                    return { redirectUrl }
                }
            })
        }
    }

    /**
     * Builds up a redirect URL. The original URL is encode and added as query
     * parameter. If WebP isn't supported the url append a flag to let the
     * server know to return in a JPEG format instead. Other flags that are
     * added are: bw (this lets the proxy know to return image in grayscale
     * as those have less color information and thus saving more space) and
     * compression level.
     * @param url
     * @returns {string}
     */
    function buildCompressUrl(url) {
        let redirectUrl = '';
        redirectUrl += state.proxyUrl;
        redirectUrl += `?url=${encodeURIComponent(url)}`;
        redirectUrl += `&jpeg=${state.isWebpSupported ? 0 : 1}`;
        redirectUrl += `&bw=${state.convertBw ? 1 : 0}`;
        redirectUrl += `&l=${state.compressionLevel}`;
        return redirectUrl;
    }

    /**
     * Firefox user agent always has "rv:" and "Gecko"
     * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/User-Agent/Firefox
     */
    function isFirefox() {
        return /rv\:.*Gecko/.test(window.navigator.userAgent)
    }

    /**
     * Retrieve saved bytes info from response headers, update statistics in
     * app storage and notify UI about state changes.
     */
    function onCompletedListener({ responseHeaders, fromCache }) {
        const bytesSaved = getHeaderValue(responseHeaders, 'x-bytes-saved')
        const bytesProcessed = getHeaderValue(responseHeaders, 'x-original-size')
        if (bytesSaved !== false && bytesProcessed !== false && fromCache === false) {
            state.statistics.filesProcessed += 1
            state.statistics.bytesProcessed += bytesProcessed
            state.statistics.bytesSaved += bytesSaved

            storage.set({statistics : state.statistics})
        }
    }

    function tabActivationListener({tabId}) {
        chrome.tabs.get(tabId, tab => {
            pageUrl = parseUrl(tab.url).hostname;
            const disabled = isDisabledSite(pageUrl)
            setIcon(!disabled)
            compressed.clear(); // Reset our list of compressed images
        });
    }

    // If we navigate to a new page within a tab and it is the same we have a
    // bug where it does not process images. Because the images are still in
    // compressed even though the page changed. With onTabUpdated we reset this.
    function tabUpdateListener(){
      compressed.clear()
    }

    /**
     * Patch document's content security policy headers so that it will allow
     * images loading from our compression proxy URL.
     */
    function onHeadersReceivedListener({ responseHeaders }) {
        return {
            responseHeaders: patchContentSecurity(responseHeaders, state.proxyUrl)
        }
    }
    function attachListeners(){
        if(!chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequestListener)){
            chrome.webRequest.onBeforeRequest.addListener(
                onBeforeRequestListener,
                {
                    urls: ['<all_urls>'],
                    types: isFirefox() ? ['xmlhttprequest', 'imageset', 'image'] : ['image']
                },
                ['blocking']
            )
        }
        if(!chrome.webRequest.onCompleted.hasListener(onCompletedListener)){
            chrome.webRequest.onCompleted.addListener(
                onCompletedListener,
                {
                    urls: ['<all_urls>'],
                    types: isFirefox() ? ['xmlhttprequest', 'imageset', 'image'] : ['image']
                },
                ['responseHeaders']
            )
        }
        if(!chrome.webRequest.onHeadersReceived.hasListener(onHeadersReceivedListener)){
            chrome.webRequest.onHeadersReceived.addListener(
                onHeadersReceivedListener,
                {
                    urls: ['<all_urls>'],
                    types: ['main_frame', 'sub_frame', 'xmlhttprequest']
                },
                ['blocking', 'responseHeaders']
            )
        }
        if(!chrome.tabs.onActivated.hasListener(tabActivationListener)){
            chrome.tabs.onActivated.addListener(tabActivationListener)
        }
        if(!chrome.tabs.onUpdated.hasListener(tabUpdateListener)){
            chrome.tabs.onUpdated.addListener(tabUpdateListener)
        }
    }

    function detachListeners(){
        chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestListener)
        chrome.webRequest.onCompleted.removeListener(onCompletedListener)
        chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceivedListener)
        chrome.tabs.onActivated.removeListener(tabActivationListener)
        chrome.tabs.onUpdated.removeListener(tabUpdateListener)
    }

    if(!chrome.storage.onChanged.hasListener(updateState)){
        chrome.storage.onChanged.addListener(updateState)
    }
    if(!chrome.runtime.onInstalled.hasListener(checkSetup)){
        chrome.runtime.onInstalled.addListener(checkSetup)
    }
})
