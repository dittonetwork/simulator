import dotenv from 'dotenv';
import { getLogger } from './logger.js';
import type { Logger } from 'pino';
import { ethers } from 'ethers';
import axios from 'axios';

dotenv.config();

const logger = getLogger('ReportingClient');

class ReportingClient {
  private apiUrl: string;
  private privateKey: string;
  private wallet: ethers.Wallet;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  
  constructor() {
    this.apiUrl = process.env.IPFS_SERVICE_URL as string;
    this.privateKey = process.env.EXECUTOR_PRIVATE_KEY as string;

    if (!this.apiUrl) {
      throw new Error('IPFS_SERVICE_URL is not defined in environment variables');
    }

    if (!this.privateKey) {
        throw new Error('EXECUTOR_PRIVATE_KEY is not defined in environment variables');
    }
    
    this.wallet = new ethers.Wallet(this.privateKey);
  }

  async initialize() {
    logger.info('Initializing ReportingClient and authenticating...');
    await this._register();
  }

  private async getNonce(): Promise<string> {
    const response = await axios.post(`${this.apiUrl}/operator/nonce`, {
        publicKey: this.wallet.address,
    });
    return response.data.nonce;
  }

  private async _register() {
    try {
        logger.info('Registering operator...');
        const nonce = await this.getNonce();
        const signature = await this.wallet.signMessage(nonce);
        
        const response = await axios.post(`${this.apiUrl}/operator/register`, {
            publicKey: this.wallet.address,
            signature: signature,
        });

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        logger.info('Operator registered successfully.');
    } catch (error) {
        logger.error('Failed to register operator', error);
        throw new Error('Could not register operator with the reporting service.');
    }
  }

  private async _refreshToken() {
    try {
        logger.info('Refreshing token...');
        if (!this.refreshToken) {
            throw new Error('No refresh token available.');
        }

        const response = await axios.post(`${this.apiUrl}/operator/refresh-token`, {
            refreshToken: this.refreshToken,
        });

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        logger.info('Token refreshed successfully.');
    } catch (error) {
        logger.error('Failed to refresh token', error);
        // If refresh fails, try to re-register
        await this._register();
    }
  }

  private async request(method: 'get' | 'post' | 'put' | 'delete', endpoint: string, data?: any) {
    const url = `${this.apiUrl}${endpoint}`;
    const headers = {
        Authorization: `Bearer ${this.accessToken}`
    };

    try {
        const response = await axios({ method, url, data, headers });
        return response.data;
    } catch (error: any) {
        if (error.response && error.response.status === 401) {
            logger.warn('Request failed with 401. Refreshing token and retrying...');
            await this._refreshToken();
            // afrer refresh try again
            const newHeaders = {
                Authorization: `Bearer ${this.accessToken}`
            };
            const response = await axios({ method, url, data, headers: newHeaders });
            return response.data;
        }
        throw error;
    }
  }

  public async submitReport(report: any) {
    logger.info(`Submitting report for ipfsHash: ${report.ipfsHash}`);
    try {
      const response = await this.request('post', '/operator/submit-report', { report });
      logger.info('Report submitted successfully.');
      return response;
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message;
      logger.error(`Failed to submit report: ${errorMessage}`, error);
      throw error;
    }
  }
}

export const reportingClient = new ReportingClient(); 