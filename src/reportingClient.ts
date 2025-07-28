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

  getAccessToken() {
    return this.accessToken;
  }

  getRefreshToken() {
    return this.refreshToken;
  }

  setTokens(accessToken: string, refreshToken: string) {
    logger.info(`Tokens set programmatically. Access token is ${accessToken ? 'present' : 'absent'}.`);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  async initialize() {
    logger.info('Initializing ReportingClient...');
    if (!this.accessToken) {
        logger.info('No access token found, proceeding to register.');
        await this._register();
    } else {
        logger.info('Access token already present, skipping registration.');
    }
  }

  private async getNonce(): Promise<string> {
    const response = await axios.post(`${this.apiUrl}/operator/nonce`, {
        walletAddress: this.wallet.address,
    });
    return response.data.nonce;
  }

  private async _register() {
    try {
        logger.info('Registering operator...');
        const nonce = await this.getNonce();
        const signature = await this.wallet.signMessage(nonce);
        
        const response = await axios.post(`${this.apiUrl}/operator/register`, {
            walletAddress: this.wallet.address,
            signature: signature,
        });

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        logger.info('Operator registered successfully.');
    } catch (error) {
        logger.error({ error: error }, 'Failed to register operator');
        throw new Error('Could not register operator with the reporting service.');
    }
  }

  async doRefreshToken() {
    await this._refreshToken();
  }

  private async _refreshToken() {
    try {
        logger.info('Refreshing token...');
        if (!this.refreshToken) {
            throw new Error('No refresh token available.');
        }

        const response = await axios.post(`${this.apiUrl}/operator/refresh-token`, {
            refreshToken: this.refreshToken,
        }, {
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        });

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        logger.info('Token refreshed successfully.');
    } catch (error) {
        logger.error({ error: error }, 'Failed to refresh token');
        // If refresh fails, try to re-register
        await this._register();
    }
  }

  private async request(method: 'get' | 'post' | 'put' | 'delete', endpoint: string, data?: any) {
    const url = `${this.apiUrl}${endpoint}`;
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const headers = {
                Authorization: `Bearer ${this.accessToken}`
            };
            const response = await axios({ method, url, data, headers });
            return response.data;
        } catch (error: any) {
            lastError = error;

            if (error.response && error.response.status === 401) {
                logger.warn(`Request failed with 401 on attempt ${attempt} of ${maxRetries}. Refreshing token...`);
                if (attempt < maxRetries) {
                    try {
                        await this._refreshToken();
                        continue;
                    } catch (refreshError) {
                        logger.error({ error: refreshError }, 'Failed to refresh token, aborting request.');
                        throw refreshError;
                    }
                }
            }
            
            const isNetworkError = !error.response;
            const isServerError = error.response && error.response.status >= 500;

            if (isNetworkError || isServerError) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    logger.warn(`Request failed on attempt ${attempt} of ${maxRetries}. Retrying in ${delay}ms...`, {
                        errorMessage: error.message,
                    });
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            } else if (!(error.response && error.response.status === 401)) {
                throw error;
            }
        }
    }

    logger.error(`Request failed after ${maxRetries} attempts.`);
    throw lastError;
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