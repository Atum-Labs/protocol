import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { Interceptors } from './core/OpenAPI';
import { AxiosHttpRequest } from './core/AxiosHttpRequest';

import { ConfigurationService } from './services.gen';
import { HealthService } from './services.gen';
import { PaymentsService } from './services.gen';
import { UsersService } from './services.gen';

type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;

export class WalletOrchClient {

	public readonly configuration: ConfigurationService;
	public readonly health: HealthService;
	public readonly payments: PaymentsService;
	public readonly users: UsersService;

	public readonly request: BaseHttpRequest;

	constructor(config?: Partial<OpenAPIConfig>, HttpRequest: HttpRequestConstructor = AxiosHttpRequest) {
		this.request = new HttpRequest({
			BASE: config?.BASE ?? 'https://wallet-orch.production-mainnet.atum.xyz',
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

		this.configuration = new ConfigurationService(this.request);
		this.health = new HealthService(this.request);
		this.payments = new PaymentsService(this.request);
		this.users = new UsersService(this.request);
	}
}
