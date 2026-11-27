// Generated from OpenAPI specification
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { components } from './types';

export type VerifyFulfillmentRequest = components['schemas']['VerifyFulfillmentRequest'];
export type VerifyFulfillmentResponse = components['schemas']['VerifyFulfillmentResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type VerificationDetails = components['schemas']['VerificationDetails'];

export class VeriFillClient {
  private client: AxiosInstance;

  constructor(baseURL: string, config?: AxiosRequestConfig) {
    this.client = axios.create({
      baseURL,
      ...config,
    });
  }

  async verifyFulfillment(request: VerifyFulfillmentRequest): Promise<VerifyFulfillmentResponse> {
    const response = await this.client.post<VerifyFulfillmentResponse>('/fulfillment', request);
    return response.data;
  }

  async getHealth(): Promise<HealthResponse> {
    const response = await this.client.get<HealthResponse>('/health');
    return response.data;
  }
}

export default VeriFillClient;