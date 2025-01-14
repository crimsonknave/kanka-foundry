import kanka from '../kanka';
import { logError, logInfo } from '../logger';
import EntityType from '../types/EntityType';
import { KankaApiCampaign, KankaApiChildEntity, KankaApiEntity, KankaApiId } from '../types/kanka';
import { ProgressFn } from '../types/progress';
import { path as template } from './KankaBrowserApplication.hbs';
import './KankaBrowserApplication.scss';

interface EntityTypeConfig {
    icon: string;
    isOpen: boolean;
}

interface TemplateData {
    campaign?: KankaApiCampaign;
    kankaCampaignId?: KankaApiId;
    data?: KankaApiEntity[];
    typeConfig: Record<string, EntityTypeConfig>,
    currentFilter: string;
    deletedEntries: KankaApiChildEntity[];
    settings: {
        showPrivate: boolean;
        view: typeof kanka.settings.browserView;
    },
}

const entityTypes: Partial<Record<EntityType, { icon: string }>> = {
    [EntityType.ability]: {
        icon: 'fa-fire',
    },
    [EntityType.character]: {
        icon: 'fa-user',
    },
    [EntityType.event]: {
        icon: 'fa-bolt',
    },
    [EntityType.family]: {
        icon: 'fa-users',
    },
    [EntityType.item]: {
        icon: 'fa-crown',
    },
    [EntityType.journal]: {
        icon: 'fa-feather-alt',
    },
    [EntityType.location]: {
        icon: 'fa-chess-rook',
    },
    [EntityType.note]: {
        icon: 'fa-book-open',
    },
    [EntityType.organisation]: {
        icon: 'fa-theater-masks',
    },
    [EntityType.quest]: {
        icon: 'fa-map-signs',
    },
    [EntityType.race]: {
        icon: 'fa-dragon',
    },
};

export default class KankaBrowserApplication extends Application {
    #currentFilter = '';
    #entities: KankaApiEntity[] | undefined;

    static get defaultOptions(): Application.Options {
        return {
            ...super.defaultOptions,
            id: 'kanka-browser',
            classes: ['kanka', 'kanka-browser'],
            template,
            width: 720,
            height: 'auto',
            title: kanka.getMessage('browser.title'),
            tabs: [{ navSelector: '.tabs', contentSelector: '.tab-container', initial: 'import' }],
            resizable: true,
        };
    }

    protected get campaign(): KankaApiCampaign {
        if (!kanka.currentCampaign) throw new Error('Campaign has not been loaded yet.');
        return kanka.currentCampaign;
    }

    protected get deletedSnapshots(): KankaApiChildEntity[] {
        return kanka.journals
            .findAllKankaEntries()
            .flatMap((entry) => {
                const campaignId = kanka.journals.getFlag(entry, 'campaign');
                const snapshot = kanka.journals.getFlag(entry, 'snapshot');

                if (!snapshot) return [];
                if (!this.#entities) return [];
                if (campaignId !== kanka.currentCampaign?.id) return [];
                if (this.#entities.some(e => e.id === snapshot.entity_id)) return [];

                return [snapshot];
            });
    }

    public getData(): TemplateData {
        const typeConfig = {};

        Object
            .entries(entityTypes)
            .forEach(([type, cfg]) => {
                typeConfig[type] = {
                    ...cfg,
                    isOpen: true,
                };
            });

        return {
            ...super.getData(),
            campaign: this.campaign,
            kankaCampaignId: this.campaign.id,
            currentFilter: this.#currentFilter,
            typeConfig,
            data: this.#entities,
            deletedEntries: this.deletedSnapshots,
            settings: {
                showPrivate: kanka.settings.importPrivateEntities,
                view: kanka.settings.browserView,
            },
        };
    }

    public async activateListeners(html: JQuery): Promise<void> {
        super.activateListeners(html);
        this.filterList(this.#currentFilter);

        html.on('input', '[name="filter"]', (event) => {
            const filter = event?.target?.value ?? '';

            if (!filter.trim().length) {
                this.resetFilter();
                return;
            }

            this.filterList(filter);
        });

        html.on('click', 'button[data-action]', async (event) => {
            const { action, id: idString, type } = event.currentTarget?.dataset ?? {};
            const id = parseInt(idString, 10);

            logInfo('click', { action, id }, kanka.currentCampaign);

            try {
                switch (action) {
                    case 'view-grid': {
                        await kanka.settings.setBrowserView('grid');
                        this.render();
                        break;
                    }

                    case 'view-list': {
                        await kanka.settings.setBrowserView('list');
                        this.render();
                        break;
                    }

                    case 'open': {
                        const sheet = kanka.journals.findByEntityId(id)?.sheet;
                        sheet?.render(true);
                        sheet?.maximize();
                        break;
                    }

                    case 'sync': {
                        const entity = this.#entities?.find(e => e.id === id);
                        if (!entity) return;
                        this.setLoadingState(event.currentTarget);
                        await kanka.journals.write(this.campaign.id, [entity], this.#entities);
                        this.render();
                        break;
                    }

                    case 'link-type': {
                        if (!type) return;
                        const unlinkedEntities = this.#entities?.filter((entity) => {
                            if (entity.type !== type) return false;
                            return !kanka.journals.findByEntityId(entity.id);
                        }) ?? [];

                        const updateProgress = this.setLoadingState(event.currentTarget, true);
                        await kanka.journals.write(this.campaign.id, unlinkedEntities, this.#entities, updateProgress);
                        this.render();
                        break;
                    }

                    case 'link-all': {
                        const unlinkedEntities = this.#entities
                            ?.filter(entity => !kanka.journals.findByEntityId(entity.id)) ?? [];

                        const updateProgress = this.setLoadingState(event.currentTarget, true);
                        await kanka.journals.write(this.campaign.id, unlinkedEntities, this.#entities, updateProgress);
                        this.render();
                        break;
                    }

                    case 'update-outdated': {
                        const outdatedEntities = this.#entities?.filter((entity) => {
                            if (!kanka.journals.hasOutdatedEntryByEntityId(entity)) {
                                return false;
                            }

                            return !type || entity.type === type;
                        }) ?? [];

                        const updateProgress = this.setLoadingState(event.currentTarget, true);
                        await kanka.journals.write(this.campaign.id, outdatedEntities, this.#entities, updateProgress);
                        this.render();
                        break;
                    }

                    case 'delete': {
                        const entry = kanka.journals.findByEntityId(id);
                        await entry?.delete({});
                        break;
                    }

                    case 'delete-all': {
                        await Promise.all(this.deletedSnapshots.map(async (snapshot) => {
                            const entry = kanka.journals.findByEntityId(snapshot.entity_id);
                            await entry?.delete({});
                        }));
                        break;
                    }

                    default:
                        break;
                }
            } catch (error) {
                logError(error);
                kanka.showError('browser.error.actionError');
                this.render(); // Ensure loaders are removed etc.
            }
        });

        html.find<HTMLDetailsElement>('details[data-type]').on('toggle', (event) => {
            const type = event.currentTarget.dataset?.type as EntityType;
            if (!type) return;
            this.setPosition({ ...this.position, height: 'auto' });
            if (this.#currentFilter) return; // Don't save toggle if filter is active
            kanka.settings.setIsTypeCollapsed(type, event.currentTarget.open);
        });
    }

    protected resetFilter(): void {
        const element = $(this.element);
        this.#currentFilter = '';
        element.find('[data-filter-text]').show();

        element.find<HTMLDetailsElement>('details[data-type]')
            .each((_, el) => {
                if (el.dataset?.type) {
                    // eslint-disable-next-line no-param-reassign
                    el.open = kanka.settings.isTypeCollapsed(el.dataset?.type as EntityType);
                }
            });

        this.setPosition({ ...this.position, height: 'auto' });
    }

    protected filterList(filter: string): void {
        if (!filter) {
            this.resetFilter();
            return;
        }

        const element = $(this.element);

        this.#currentFilter = filter
            .toLowerCase()
            .replace(/\[/g, '\\[')
            .replace(/]/g, '||]')
            .replace(/"/g, '\\"');

        element.find<HTMLDetailsElement>('details[data-type]')
            // eslint-disable-next-line no-param-reassign
            .each((_, el) => { el.open = true; });

        element.find('[data-filter-text]').hide();
        element.find(`[data-filter-text*="${this.#currentFilter}"]`).show();
        this.setPosition({ ...this.position, height: 'auto' });
    }

    protected async loadEntities(): Promise<void> {
        const entities = await kanka.api.getAllEntities(
            this.campaign.id,
            [
                'ability',
                'character',
                'location',
                'race',
                'organisation',
                'family',
                'item',
                'journal',
                'note',
                'quest',
                'event',
            ],
        );

        this.#entities = entities?.filter((entity) => {
            if (!kanka.settings.importTemplateEntities && entity.is_template) {
                return false;
            }

            if (!kanka.settings.importPrivateEntities && entity.is_private) {
                return false;
            }

            return true;
        });

        this.render();
    }

    // eslint-disable-next-line
    protected async _render(force?: boolean, options?: any): Promise<void> {
        if (force) {
            this.#entities = undefined;
            requestAnimationFrame(async () => {
                try {
                    await this.loadEntities();
                } catch (error) {
                    kanka.showError('browser.error.loadEntity');
                    logError(error);
                    await this.close();
                }
            });
        }

        await super._render(force, options);
    }

    protected setLoadingState(button: HTMLButtonElement, determined = false): ProgressFn {
        const $button = $(button);
        $button.addClass('-loading');
        $(this.element).find('[data-action]').prop('disabled', true);

        if (determined) $button.addClass('-determined');
        else $button.addClass('-undetermined');

        return (current, max) => {
            $button.addClass('-determined');
            button.style.setProperty('--progress', `${Math.round((current / max) * 100)}%`);
        };
    }
}
