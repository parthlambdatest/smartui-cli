import { Snapshot, Context, ProcessedSnapshot } from "../types.js";
import { scrollToBottomAndBackToTop, getRenderViewports } from "./utils.js"
import { chromium, Locator } from "@playwright/test"
import constants from "./constants.js";
import { updateLogContext } from '../lib/logger.js'

const MAX_RESOURCE_SIZE = 15 * (1024 ** 2); // 15MB
var ALLOWED_RESOURCES = ['document', 'stylesheet', 'image', 'media', 'font', 'other'];
const ALLOWED_STATUSES = [200, 201];
const REQUEST_TIMEOUT = 10000;
const MIN_VIEWPORT_HEIGHT = 1080;

export default class Queue {
    private snapshots: Array<Snapshot> = [];
    private processedSnapshots: Array<Record<string, any>> = [];
    private processing: boolean = false;
    private processingSnapshot: string = '';
    private ctx: Context;
    private snapshotNames: Array<string> = [];
    private variants: Array<string> = [];

    constructor(ctx: Context) {
        this.ctx = ctx;
    }

    enqueue(item: Snapshot, start: boolean): void {
        this.snapshots.push(item);
        if(start){
            if (!this.processing) {
                this.processing = true;
                this.processNext();
            }
        }
    }

    startProcessingfunc(): void {
        if (!this.processing) {
            this.processing = true;
            this.processNext();
        }
    }

    private processGenerateVariants(snapshot: Snapshot): void {
        if (snapshot.options) {
            if (snapshot.options.web) {
                this.generateWebVariants(snapshot, snapshot.options.web);
            }
            if (snapshot.options.mobile) {
                this.generateMobileVariants(snapshot, snapshot.options.mobile);
            }
        } 
        
        if (!snapshot.options || (!snapshot.options.web && !snapshot.options.mobile)) {
            this.generateVariants(snapshot, this.ctx.config);
        }
    }
    

    private generateVariants(snapshot: Snapshot, config: any): void {
        // Process web configurations if they exist
        
        if (config.web) {
            const browsers = config.web.browsers || [];
            const viewports = config.web.viewports || [];
            
            for (const browser of browsers) {
                for (const viewport of viewports) {
                    const width = viewport.width;
                    const height = viewport.height || 0;  // Use 0 if height is not provided
                    const variant = `${snapshot.name}_${browser}_viewport[${width}]_viewport[${height}]`;
                    this.variants.push(variant);
                }
            }
        }
    
        // Process mobile configurations if they exist
        if (config.mobile) {
            const devices = config.mobile.devices || [];
            const orientation = config.mobile.orientation || "portrait";  // Default to portrait if not provided
            const fullPage = config.mobile.fullPage ?? true; // FullPage defaults to true if not defined
            
            for (const device of devices) {
                const variant = `${snapshot.name}_${device}_${orientation}_${fullPage ? 'fullPage' : 'noFullPage'}`;
                this.variants.push(variant);
            }
        }
    }
    

    private generateWebVariants(snapshot: Snapshot, webConfig: any): void {
        const browsers = webConfig.browsers ?? this.ctx.config.web?.browsers ?? ["chrome", "edge", "firefox", "safari"];
        const viewports = webConfig.viewports || [];
        
        for (const browser of browsers) {
            for (const viewport of viewports) {
                const width = viewport[0];
                const height = viewport[1] || 0;  // Use 0 if height is not provided
                const variant = `${snapshot.name}_${browser}_viewport[${width}]_viewport[${height}]`;
                this.variants.push(variant);
            }
        }
    }

    private generateMobileVariants(snapshot: Snapshot, mobileConfig: any): void {
        const devices = mobileConfig.devices || [];
        const orientation = mobileConfig.orientation ?? this.ctx.config.mobile?.orientation ?? "portrait";
        const fullPage = mobileConfig.fullPage ?? this.ctx.config.mobile?.fullPage ?? true;
        
        for (const device of devices) {
            const variant = `${snapshot.name}_${device}_${orientation}_${fullPage ? 'fullPage' : 'noFullPage'}`;
            this.variants.push(variant);
        }
    }

    private filterExistingVariants(snapshot: Snapshot, config: any): boolean {

        let drop = true;

        if (snapshot.options && snapshot.options.web) {
            const webDrop = this.filterWebVariants(snapshot, snapshot.options.web);
            if (!webDrop) drop = false;
        }
        
        if (snapshot.options && snapshot.options.mobile) {
            const mobileDrop = this.filterMobileVariants(snapshot, snapshot.options.mobile);
            if (!mobileDrop) drop = false;
        }
        
        // Fallback to the global config if neither web nor mobile options are present in snapshot.options
        if (!snapshot.options || (snapshot.options && !snapshot.options.web && !snapshot.options.mobile)) {
            const configDrop = this.filterVariants(snapshot, config);
            if (!configDrop) drop = false;
        }
        return drop;
    }

    private filterVariants(snapshot: Snapshot, config: any): boolean {
        let allVariantsDropped = true;
    
        // Process web configurations if they exist in config
        if (config.web) {
            const browsers = config.web.browsers || [];
            const viewports = config.web.viewports || [];
    
            for (const browser of browsers) {
                for (const viewport of viewports) {
                    const width = viewport.width;
                    const height = viewport.height || 0;
                    const variant = `${snapshot.name}_${browser}_viewport[${width}]_viewport[${height}]`;
    
                    if (!this.variants.includes(variant)) {
                        allVariantsDropped = false; // Found a variant that needs processing
                        if (!snapshot.options) snapshot.options = {};
                        if (!snapshot.options.web) snapshot.options.web = { browsers: [], viewports: [] };
                        
                        if (!snapshot.options.web.browsers.includes(browser)) {
                            snapshot.options.web.browsers.push(browser);
                        }
    
                        // Check for unique viewports to avoid duplicates
                        const viewportExists = snapshot.options.web.viewports.some(existingViewport => 
                            existingViewport[0] === width &&
                            (existingViewport.length < 2 || existingViewport[1] === height)
                        );
    
                        if (!viewportExists) {
                            if (height > 0) {
                                snapshot.options.web.viewports.push([width, height]);
                            } else {
                                snapshot.options.web.viewports.push([width]);
                            }
                        }
                    }
                }
            }
        }
    
        // Process mobile configurations if they exist in config
        if (config.mobile) {
            const devices = config.mobile.devices || [];
            const orientation = config.mobile.orientation || "portrait";
            const fullPage = config.mobile.fullPage || true;
    
            for (const device of devices) {
                const variant = `${snapshot.name}_${device}_${orientation}_${fullPage ? 'fullPage' : 'noFullPage'}`;
    
                if (!this.variants.includes(variant)) {
                    allVariantsDropped = false; // Found a variant that needs processing
                    if (!snapshot.options) snapshot.options = {};
                    if (!snapshot.options.mobile) snapshot.options.mobile = { devices: [], orientation: "portrait", fullPage: true };
                    
                    if (!snapshot.options.mobile.devices.includes(device)) {
                        snapshot.options.mobile.devices.push(device);
                    }
                    snapshot.options.mobile.orientation = orientation;
                    snapshot.options.mobile.fullPage = fullPage;
                }
            }
        }
    
        return allVariantsDropped;
    }    
    
    private filterWebVariants(snapshot: Snapshot, webConfig: any): boolean {
        const browsers = webConfig.browsers ?? this.ctx.config.web?.browsers ?? ["chrome", "edge", "firefox", "safari"];
        const viewports = webConfig.viewports || [];
        let allVariantsDropped = true;
    
        if (!snapshot.options) {
            snapshot.options = {};
        }
    
        snapshot.options.web = { browsers: [], viewports: [] };
        
        for (const browser of browsers) {
            for (const viewport of viewports) {
                const width = viewport[0];
                const height = viewport[1] || 0;
                const variant = `${snapshot.name}_${browser}_viewport[${width}]_viewport[${height}]`;
    
                if (!this.variants.includes(variant)) {
                    allVariantsDropped = false; // Found a variant that needs processing
                    if (!snapshot.options.web.browsers.includes(browser)) {
                        snapshot.options.web.browsers.push(browser);
                    }
                    // Only add unique viewports to avoid duplicates
                    const viewportExists = snapshot.options.web.viewports.some(existingViewport => 
                        existingViewport[0] === width &&
                        (existingViewport.length < 2 || existingViewport[1] === height)
                    );         
                    console.log(variant)
                    console.log(viewportExists)           
                    if (!viewportExists) {
                        if (height > 0) {
                            snapshot.options.web.viewports.push([width, height]);
                        } else {
                            snapshot.options.web.viewports.push([width]);
                        }
                    }
                }
            }
        }
        return allVariantsDropped;
    }
    
    
    private filterMobileVariants(snapshot: Snapshot, mobileConfig: any): boolean {
        if (!snapshot.options) {
            snapshot.options = {};
        }

        snapshot.options.mobile = { devices: [], orientation: "portrait", fullPage: true };

        const devices = mobileConfig.devices || [];
        const orientation = mobileConfig.orientation ?? this.ctx.config.mobile?.orientation ?? "portrait";
        const fullPage = mobileConfig.fullPage ?? this.ctx.config.mobile?.fullPage ?? true;
        let allVariantsDropped = true;
        
        for (const device of devices) {
            const variant = `${snapshot.name}_${device}_${orientation}_${fullPage ? 'fullPage' : 'noFullPage'}`;
    
            if (!this.variants.includes(variant)) {
                allVariantsDropped = false; // Found a variant that needs processing
                snapshot.options.mobile.devices.push(device);
                snapshot.options.mobile.orientation = orientation;
                snapshot.options.mobile.fullPage = fullPage;
            }
        }
        return allVariantsDropped;
    }
    
    

    private async processNext(): Promise<void> {
        if (!this.isEmpty()) {
            let snapshot;
            if (this.ctx.config.deferUploads){
                snapshot = this.snapshots.pop();
            } else {
                snapshot = this.snapshots.shift();
            }
            try {
                this.processingSnapshot = snapshot?.name;
                let drop = false;

                if (snapshot && snapshot.name && this.snapshotNames.includes(snapshot.name)) {
                    drop = this.filterExistingVariants(snapshot, this.ctx.config);
                }

                if (snapshot && snapshot.name && !this.snapshotNames.includes(snapshot.name)) {
                    this.snapshotNames.push(snapshot.name);
                }

                if (snapshot) {
                    this.processGenerateVariants(snapshot);
                }

                console.log("***********")
                console.log(JSON.stringify(snapshot.options))

                if (!drop) {
                    let { processedSnapshot, warnings } = await processSnapshot(snapshot, this.ctx);
                    await this.ctx.client.uploadSnapshot(this.ctx, processedSnapshot);
                    this.ctx.totalSnapshots++;
                    this.processedSnapshots.push({ name: snapshot.name, warnings });
                }
            } catch (error: any) {
                this.ctx.log.debug(`snapshot failed; ${error}`);
                this.processedSnapshots.push({ name: snapshot.name, error: error.message });
            }
            // Close open browser contexts and pages
            if (this.ctx.browser) {
                for (let context of this.ctx.browser.contexts()) {
                    for (let page of context.pages()) {
                        await page.close();
                        this.ctx.log.debug(`Closed browser page for snapshot ${snapshot.name}`);
                    }
                    await context.close();
                    this.ctx.log.debug(`Closed browser context for snapshot ${snapshot.name}`);
                }
            }
            this.processNext();
        } else {
            this.processing = false;
        }
    }

    isProcessing(): boolean {
        return this.processing;
    }

    getProcessingSnapshot(): string {
        return this.processingSnapshot;
    }

    getProcessedSnapshots(): Array<Record<string, any>> {
        return this.processedSnapshots;
    }

    isEmpty(): boolean {
        return this.snapshots && this.snapshots.length ? false : true;
    }
}

async function processSnapshot(snapshot: Snapshot, ctx: Context): Promise<Record<string, any>> {
    updateLogContext({ task: 'discovery' });
    ctx.log.debug(`Processing snapshot ${snapshot.name} ${snapshot.url}`);

    let launchOptions: Record<string, any> = {
        headless: true,
        args: constants.LAUNCH_ARGS
    }
    let contextOptions: Record<string, any> = {
        javaScriptEnabled: ctx.config.cliEnableJavaScript,
        userAgent: constants.CHROME_USER_AGENT,
    }
    if (!ctx.browser?.isConnected()) {
        if (ctx.env.HTTP_PROXY || ctx.env.HTTPS_PROXY) launchOptions.proxy = { server: ctx.env.HTTP_PROXY || ctx.env.HTTPS_PROXY };
        ctx.browser = await chromium.launch(launchOptions);
        ctx.log.debug(`Chromium launched with options ${JSON.stringify(launchOptions)}`);
    }
    const context = await ctx.browser.newContext(contextOptions);
    ctx.log.debug(`Browser context created with options ${JSON.stringify(contextOptions)}`);
    // Setting cookies in playwright context
    if (!ctx.env.SMARTUI_DO_NOT_USE_CAPTURED_COOKIES && snapshot.dom.cookies) {
        const domainName = new URL(snapshot.url).hostname;
        ctx.log.debug(`Setting cookies for domain: ${domainName}`);

        const cookieArray = snapshot.dom.cookies.split('; ').map(cookie => {
            if (!cookie) return null;
            const [name, value] = cookie.split('=');
            if (!name || !value) return null;

            return {
                name: name.trim(),
                value: value.trim(),
                domain: domainName,
                path: '/'
            };
        }).filter(Boolean);

        if (cookieArray.length > 0) {
            await context.addCookies(cookieArray);
        } else {
            ctx.log.debug('No valid cookies to add');
        }
    }
    const page = await context.newPage();

    // populate cache with already captured resources
    let cache: Record<string, any> = {};
    if (snapshot.dom.resources.length) {
        for (let resource of snapshot.dom.resources) {
            // convert text/css content to base64
            let body = resource.mimetype == 'text/css' ? Buffer.from(resource.content).toString('base64') : resource.content;
            cache[resource.url] = {
                body: body,
                type: resource.mimetype
            }
        }
    }

    // Use route to intercept network requests and discover resources
    await page.route('**/*', async (route, request) => {
        const requestUrl = request.url()
        const requestHostname = new URL(requestUrl).hostname;
        let requestOptions: Record<string, any> = {
            timeout: REQUEST_TIMEOUT,
            headers: {
                ...await request.allHeaders(),
                ...constants.REQUEST_HEADERS
            }
        }

        try {
            // abort audio/video media requests
            if (/\.(mp3|mp4|wav|ogg|webm)$/i.test(request.url())) {
                throw new Error('resource type mp3/mp4/wav/ogg/webm');
            }

            // handle discovery config
            ctx.config.allowedHostnames.push(new URL(snapshot.url).hostname);
            if (ctx.config.enableJavaScript) ALLOWED_RESOURCES.push('script');
            if (ctx.config.basicAuthorization) {
                ctx.log.debug(`Adding basic authorization to the headers for root url`);
                let token = Buffer.from(`${ctx.config.basicAuthorization.username}:${ctx.config.basicAuthorization.password}`).toString('base64');
                requestOptions.headers.Authorization = `Basic ${token}`;
            }

            // get response
            let response, body;
            if (requestUrl === snapshot.url) {
                response = {
                    status: () => 200,
                    headers: () => ({ 'content-type': 'text/html' })
                }
                body = snapshot.dom.html;
            } else if (cache[requestUrl]) {
                response = {
                    status: () => 200,
                    headers: () => ({ 'content-type': cache[requestUrl].mimetype })
                }
                body = cache[requestUrl].body;
            } else {
                response = await page.request.fetch(request, requestOptions);
                body = await response.body();
            }

            // handle response
            if (!body) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping no response`);
            } else if (!body.length) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping empty response`);
            } else if (requestUrl === snapshot.url) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping root resource`);
            } else if (!ctx.config.allowedHostnames.includes(requestHostname)) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping remote resource`);
            } else if (cache[requestUrl]) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping already cached resource`);
            } else if (body.length > MAX_RESOURCE_SIZE) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping resource larger than 15MB`);
            } else if (!ALLOWED_STATUSES.includes(response.status())) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping disallowed status [${response.status()}]`);
            } else if (!ALLOWED_RESOURCES.includes(request.resourceType())) {
                ctx.log.debug(`Handling request ${requestUrl}\n - skipping disallowed resource type [${request.resourceType()}]`);
            } else {
                ctx.log.debug(`Handling request ${requestUrl}\n - content-type ${response.headers()['content-type']}`);
                cache[requestUrl] = {
                    body: body.toString('base64'),
                    type: response.headers()['content-type']
                }
            }

            // Continue the request with the fetched response
            route.fulfill({
                status: response.status(),
                headers: response.headers(),
                body: body,
            });
        } catch (error: any) {
            ctx.log.debug(`Handling request ${requestUrl}\n - aborted due to ${error.message}`);
            route.abort();
        }
    });

    let options = snapshot.options;
    let optionWarnings: Set<string> = new Set();
    let processedOptions: Record<string, any> = {};
    let selectors: Array<string> = [];
    let ignoreOrSelectDOM: string;
    let ignoreOrSelectBoxes: string;
    if (options && Object.keys(options).length) {
        ctx.log.debug(`Snapshot options: ${JSON.stringify(options)}`);

        const isNotAllEmpty = (obj: Record<string, Array<string>>): boolean => {
            for (let key in obj) if (obj[key]?.length) return true;
            return false;
        }

        if (options.element && Object.keys(options.element).length) {
            if (options.element.id) processedOptions.element = '#' + options.element.id;
            else if (options.element.class) processedOptions.element = '.' + options.element.class;
            else if (options.element.cssSelector) processedOptions.element = options.element.cssSelector;
            else if (options.element.xpath) processedOptions.element = 'xpath=' + options.element.xpath;
        } else if (options.ignoreDOM && Object.keys(options.ignoreDOM).length && isNotAllEmpty(options.ignoreDOM)) {
            processedOptions.ignoreBoxes = {};
            ignoreOrSelectDOM = 'ignoreDOM';
            ignoreOrSelectBoxes = 'ignoreBoxes';
        } else if (options.selectDOM && Object.keys(options.selectDOM).length && isNotAllEmpty(options.selectDOM)) {
            processedOptions.selectBoxes = {};
            ignoreOrSelectDOM = 'selectDOM';
            ignoreOrSelectBoxes = 'selectBoxes';
        }
        if (ignoreOrSelectDOM) {
            for (const [key, value] of Object.entries(options[ignoreOrSelectDOM])) {
                switch (key) {
                    case 'id':
                        selectors.push(...value.map(e => '#' + e));
                        break;
                    case 'class':
                        selectors.push(...value.map(e => '.' + e));
                        break;
                    case 'xpath':
                        selectors.push(...value.map(e => 'xpath=' + e));
                        break;
                    case 'cssSelector':
                        selectors.push(...value);
                        break;
                }
            }
        }
    }

    // process for every viewport
    let navigated: boolean = false;
    let previousDeviceType: string | null = null;
    let renderViewports = getRenderViewports(ctx);

    for (const { viewport, viewportString, fullPage, device } of renderViewports) {

        // Check if this is the first iteration or if the device type has changed from the previous iteration
        if (previousDeviceType !== null && previousDeviceType !== device) {
            // If the device type has changed, reset `navigated` to false
            // This indicates that we haven't navigated to the required page for the new device type yet
            navigated = false;
        }

        // Update `previousDeviceType` to the current device type for comparison in the next iteration
        previousDeviceType = device;

        await page.setViewportSize({ width: viewport.width, height: viewport.height || MIN_VIEWPORT_HEIGHT });
        ctx.log.debug(`Page resized to ${viewport.width}x${viewport.height || MIN_VIEWPORT_HEIGHT}`);

        // navigate to snapshot url once
        if (!navigated) {
            try {
                // domcontentloaded event is more reliable than load event
                await page.goto(snapshot.url, { waitUntil: "domcontentloaded" });
                // adding extra timeout since domcontentloaded event is fired pretty quickly
                await new Promise(r => setTimeout(r, 1250));
                if (ctx.config.waitForTimeout) await page.waitForTimeout(ctx.config.waitForTimeout);
                navigated = true;
                ctx.log.debug(`Navigated to ${snapshot.url}`);
            } catch (error: any) {
                ctx.log.debug(`Navigation to discovery page failed; ${error}`)
                throw new Error(error.message)
            }

        }
        if (ctx.config.cliEnableJavaScript && fullPage) await page.evaluate(scrollToBottomAndBackToTop, { frequency: 100, timing: ctx.config.scrollTime });

        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 });
            ctx.log.debug('Network idle 500ms');
        } catch (error) {
            ctx.log.debug(`Network idle failed due to ${error}`);
        }

        // snapshot options
        if (processedOptions.element) {
            let l = await page.locator(processedOptions.element).all()
            if (l.length === 0) {
                throw new Error(`for snapshot ${snapshot.name} viewport ${viewportString}, no element found for selector ${processedOptions.element}`);
            } else if (l.length > 1) {
                throw new Error(`for snapshot ${snapshot.name} viewport ${viewportString}, multiple elements found for selector ${processedOptions.element}`);
            }
        } else if (selectors.length) {
            let locators: Array<Locator> = [];
            if (!Array.isArray(processedOptions[ignoreOrSelectBoxes][viewportString])) processedOptions[ignoreOrSelectBoxes][viewportString] = []

            for (const selector of selectors) {
                let l = await page.locator(selector).all()
                if (l.length === 0) {
                    optionWarnings.add(`for snapshot ${snapshot.name} viewport ${viewportString}, no element found for selector ${selector}`);
                    continue;
                }
                locators.push(...l);
            }
            for (const locator of locators) {
                let bb = await locator.boundingBox();
                if (bb) processedOptions[ignoreOrSelectBoxes][viewportString].push({
                    left: bb.x,
                    top: bb.y,
                    right: bb.x + bb.width,
                    bottom: bb.y + bb.height
                });
            }
        }
    }

    return {
        processedSnapshot: {
            name: snapshot.name,
            url: snapshot.url,
            dom: Buffer.from(snapshot.dom.html).toString('base64'),
            resources: cache,
            options: processedOptions
        },
        warnings: [...optionWarnings, ...snapshot.dom.warnings]
    }
}
