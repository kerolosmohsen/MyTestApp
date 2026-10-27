'use strict';

/* global device, element, by */

describe('App launch', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  it('launches successfully', async () => {
    await expect(element(by.text('Welcome to React Native'))).toBeVisible();
  });
});
