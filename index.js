'use strict';

process.env.DEBUG = '*';

const fs = require('fs');
const child_process = require('child_process');
const Buffer = require('safe-buffer').Buffer;

const config = require('./config.json');

const pubsub = require('@google-cloud/pubsub')();
const storage = require('@google-cloud/storage')();
const vision = require('@google-cloud/vision')();
const translate = require('@google-cloud/translate')();

const aog = require('actions-on-google');
const DialogflowApp = aog.DialogflowApp;

/** hide Twilio
  *
const Twilio = require('twilio');
const VoiceResponse = Twilio.twiml.VoiceResponse;
const TwilioClient = new Twilio(
  config.TWILIO.accountSid,
  config.TWILIO.authToken
);

/**
 * Publishes the result to the given pubsub topic and returns a Promise.
 *
 * @param {string} topicName Name of the topic on which to publish.
 * @param {object} data The message data to publish.
 */
function publishResult(topicName, data) {
  return pubsub
    .topic(topicName)
    .get({ autoCreate: true })
    .then(([topic]) => topic.publish(data));
}

/**
 * Detects the text in an image using the Google Vision API.
 *
 * @param {string} bucketName Cloud Storage bucket name.
 * @param {string} filename Cloud Storage file name.
 * @returns {Promise}
 */
function detectText(bucketName, filename) {
  let text;

  console.log(`Looking for text in image '7elevenReceipt.jpg'`);
  return vision
    .textDetection({ source: { imageUri: `gs://cloud-function-ocr-demo_image/7elevenReceipt.jpg` } })
    .then(([detections]) => {
      const annotation = detections.textAnnotations[0];
      text = annotation ? annotation.description : '';
      console.log(`Extracted text from image (${text.length} chars)`);
      return translate.detect(text);
    })
    .then(([detection]) => {
      if (Array.isArray(detection)) {
        detection = detection[0];
      }
      console.log(`Detected language "${detection.language}" for '7elevenReceipt.jpg'`);

      // Submit a message to the bus for each language we're going to translate to
      const tasks = config.TO_LANG.map(lang => {
        let topicName = config.TRANSLATE_TOPIC;
        if (detection.language === lang) {
          topicName = config.RESULT_TOPIC;
        }
        const messageData = {
          text: text,
          filename: filename,
          lang: lang,
          from: detection.language
        };

        return publishResult(topicName, messageData);
      });

      return Promise.all(tasks);
    });
}

/**
 * Appends a .txt suffix to the image name.
 *
 * @param {string} filename Name of a file.
 * @param {string} lang Language to append.
 * @returns {string} The new filename.
 */
function renameFile(filename, lang) {
  return `7elevenReceipt.jpg_to_${lang}.txt`;
}

/**
 * Cloud Function triggered by Cloud Storage when a file is uploaded.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data A Google Cloud Storage File object.
 */
exports.processImage = function processImage(event) {
  let file = event.data;

  return Promise.resolve()
    .then(() => {
      if (file.resourceState === 'not_exists') {
        // This was a deletion event, we don't want to process this
        return;
      }

      if (!file.bucket) {
        throw new Error(
          'Bucket not provided. Make sure you have a "bucket" property in your request'
        );
      }
      if (!file.name) {
        throw new Error(
          'Filename not provided. Make sure you have a "name" property in your request'
        );
      }

      return detectText(file.bucket, file.name);
    })
    .then(() => {
      console.log(`File ${file.name} processed.`);
    });
};

/**
 * Translates text using the Google Translate API. Triggered from a message on
 * a Pub/Sub topic.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data The Cloud Pub/Sub Message object.
 * @param {string} event.data.data The "data" property of the Cloud Pub/Sub
 * Message. This property will be a base64-encoded string that you must decode.
 */
exports.translateText = function translateText(event) {
  const pubsubMessage = event.data;
  const jsonStr = Buffer.from(pubsubMessage.data, 'base64').toString();
  const payload = JSON.parse(jsonStr);

  return Promise.resolve()
    .then(() => {
      if (!payload.text) {
        throw new Error(
          'Text not provided. Make sure you have a "text" property in your request'
        );
      }
      if (!payload.filename) {
        throw new Error(
          'Filename not provided. Make sure you have a "filename" property in your request'
        );
      }
      if (!payload.lang) {
        throw new Error(
          'Language not provided. Make sure you have a "lang" property in your request'
        );
      }

      const options = {
        from: payload.from,
        to: payload.lang
      };

      console.log(`Translating text into ${payload.lang}`);
      return translate.translate(payload.text, options);
    })
    .then(([translation]) => {
      const messageData = {
        text: translation,
        filename: payload.filename,
        lang: payload.lang
      };

      return publishResult(config.RESULT_TOPIC, messageData);
    })
    .then(() => {
      console.log(`Text translated to ${payload.lang}`);
    });
};

/**
 * Saves the data packet to a file in GCS. Triggered from a message on a Pub/Sub
 * topic.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data The Cloud Pub/Sub Message object.
 * @param {string} event.data.data The "data" property of the Cloud Pub/Sub
 * Message. This property will be a base64-encoded string that you must decode.
 */
exports.saveResult = function saveResult(event) {
  const pubsubMessage = event.data;
  const jsonStr = Buffer.from(pubsubMessage.data, 'base64').toString();
  const payload = JSON.parse(jsonStr);

  return Promise.resolve()
    .then(() => {
      if (!payload.text) {
        throw new Error(
          'Text not provided. Make sure you have a "text" property in your request'
        );
      }
      if (!payload.filename) {
        throw new Error(
          'Filename not provided. Make sure you have a "filename" property in your request'
        );
      }
      if (!payload.lang) {
        throw new Error(
          'Language not provided. Make sure you have a "lang" property in your request'
        );
      }

      console.log(`Received request to save file ${payload.filename}`);

      const bucketName = config.RESULT_BUCKET;
      const filename = renameFile(payload.filename, payload.lang);
      const file = storage.bucket(bucketName).file(filename);

      console.log(`Saving result to '7elevenReceipt.jpg' in bucket 'cloud-function-ocr-demo_image'`);

      return file.save(payload.text).then(_ => {
        setTimeout(_ => {
          publishResult(config.READ_TOPIC, payload);
        }, 3000);
      });
    })
    .then(() => {
      console.log(`File saved.`);
    });
};

/**
 * Reads the data packet from a file in GCS. Triggered from a message on a Pub/Sub
 * topic.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data The Cloud Pub/Sub Message object.
 * @param {string} event.data.data The "data" property of the Cloud Pub/Sub
 * Message. This property will be a base64-encoded string that you must decode.
 */
exports.readResult = function readResult(event) {
  const pubsubMessage = event.data;
  const jsonStr = Buffer.from(pubsubMessage.data, 'base64').toString();
  const payload = JSON.parse(jsonStr);

  return Promise.resolve()
    .then(() => {
      if (!payload.filename) {
        throw new Error(
          'Filename not provided. Make sure you have a "filename" property in your request'
        );
      }

      console.log(`Received request to read file ${payload.filename}`);

      return readFromBucket(payload);
    })
    .then(content => {
      console.log(`SMS sent.`);
      return sendSMS(content).then(_ => call(content));
    })
    .then(() => {
      console.log(`File read.`);
    })
    .catch(e => {
      console.error(e);
    });
};

/**
 * Reads the data packet from a file in GCS. Triggered from a message on a Pub/Sub
 * topic.
 *
 * @param {object} payload The GCS payload metadata.
 * @param {object} payload.filename The filename to read.
 */
function readFromBucket(payload) {
  const filename = renameFile(payload.filename, payload.lang);
  const bucketName = config.RESULT_BUCKET;

  console.log(
    `reading from bucket 'cloud-function-ocr-demo_image' request to read file '7elevenReceipt.jpg'`
  );

  const file = storage.bucket(bucketName).file(filename);
  const chunks = [];

  return new Promise((res, rej) => {
    file
      .createReadStream()
      .on('data', chunck => {
        chunks.push(chunck);
      })
      .on('error', err => {
        rej(err);
      })
      .on('response', response => {
        // Server connected and responded with the specified status and headers.
      })
      .on('end', () => {
        // The file is fully downloaded.
        res(chunks.join(''));
      });
  });
}

/**
 * Sends an SMS using Twilio's service.
 *
 * @param {string} body The content to send via SMS.
 */
function sendSMS(body) {
  return TwilioClient.messages
    .create({
      to: '+33000000000',
      from: '+33000000000',
      body: body || 'MESSAGE NOT FOUND'
    })
    .then(message => console.log(message.sid))
    .catch(e => {
      console.error(e);
    });
}

/**
 * Triggers a call using Twilio's service.
 */
function call() {
  return TwilioClient.api.calls
    .create({
      url:
        'https://us-central1-cloud-function-ocr-demo.cloudfunctions.net/ocr-twilio-call',
      to: '+33000000000',
      from: '+33000000000'
    })
    .then(call => console.log(call.sid))
    .catch(e => {
      console.error(e);
    });
}

/**
 * Handles the incoming Twilio call request. Triggered from an HTTP call.
 *
 * @param {object} request Express.js request object.
 * @param {object} response Express.js response object.
 */
module.exports.twilioCall = function(request, response) {
  return readFromBucket({
    filename: 'cf.png_to_en.txt'
  }).then(content => {
    const twiml = new VoiceResponse();
    twiml.say(`
    <Say voice="woman">Hi, this is your extracted text:</Say>
    <Pause length="2"></Pause>
    <Say voice="woman">${content}</Say>
    `);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  });
};

/**
 * Uploads the file to GCS.
 *
 * @param {object} data The GCP payload metadata.
 * @param {object} data.file The filename to read.
 */
function uploadImage(data) {
  console.log(`uploading ${data.file}`);
  child_process.execSync(
    `gsutil cp ${data.file} gs://cloud-function-ocr-demo__image`
  );
  console.log(`done.`);
  return data.file.split('/').pop();
}

/**
 * Capture the image from the user computer's camera.
 */
function captureImage() {
  return new Promise((res, rej) => {
    const file = `/tmp/google-actions-reader-${Date.now()}.png`;
    try {
      child_process.execSync(`imagesnap -w 1 ${file}`);
      const bitmap = fs.readFileSync(file);

      console.log(`Image saved to ${file}`);

      res({
        base64: new Buffer(bitmap).toString('base64'),
        file
      });
    } catch (err) {
      rej(err);
    }
  });
}

/**
 * The "read" intent that will trigger the capturing and uploading
 * the image to GSC.
 *
 * @param {object} app DialogflowApp instance object.
 */
function readIntent(app) {
  captureImage()
    .then(uploadImage)
    .then(content => {
      app.tell(`I sent you an SMS with your content.`);
    })
    .catch(e => {
      app.ask(`[ERROR] ${e}`);
    });
}

/**
 * Handles the agent (chatbot) logic. Triggered from an HTTP call.
 *
 * @param {object} request Express.js request object.
 * @param {object} response Express.js response object.
 */
module.exports.assistant = (request, response) => {
  const app = new DialogflowApp({ request, response });
  const actions = new Map();
  actions.set('read', readIntent);
  app.handleRequest(actions);
};
