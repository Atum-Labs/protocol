import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { Interceptors } from './core/OpenAPI';
import { AxiosHttpRequest } from './core/AxiosHttpRequest';

import { EscrowsService } from './services.gen';
import { FinalityService } from './services.gen';
import { FulfillmentService } from './services.gen';
import { HealthService } from './services.gen';
import { KeysService } from './services.gen';
import { RefundService } from './services.gen';
import { SignaturesService } from './services.gen';

type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;

export class VeriFillClient {

	public readonly escrows: EscrowsService;
	public readonly finality: FinalityService;
	public readonly fulfillment: FulfillmentService;
	public readonly health: HealthService;
	public readonly keys: KeysService;
	public readonly refund: RefundService;
	public readonly signatures: SignaturesService;

	public readonly request: BaseHttpRequest;

	constructor(config?: Partial<OpenAPIConfig>, HttpRequest: HttpRequestConstructor = AxiosHttpRequest) {
		this.request = new HttpRequest({
			BASE: config?.BASE ?? 'https://veri-fill.production-mainnet.atum.xyz',
			VERSION: config?.VERSION ?? '1.0.0',
			WITH_CREDENTIALS: config?.WITH_CREDENTIALS ?? false,
			CREDENTIALS: config?.CREDENTIALS ?? 'include',
			TOKEN: config?.TOKEN,
			USERNAME: config?.USERNAME,
			PASSWORD: config?.PASSWORD,
			HEADERS: config?.HEADERS,
			ENCODE_PATH: config?.ENCODE_PATH,
			interceptors: {
				request: config?.interceptors?.request ?? new Interceptors(),
				response: config?.interceptors?.response ?? new Interceptors(),
      },
		});

		this.escrows = new EscrowsService(this.request);
		this.finality = new FinalityService(this.request);
		this.fulfillment = new FulfillmentService(this.request);
		this.health = new HealthService(this.request);
		this.keys = new KeysService(this.request);
		this.refund = new RefundService(this.request);
		this.signatures = new SignaturesService(this.request);
	}
}
