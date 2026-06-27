import * as tf from '@tensorflow/tfjs-node';
import fs from 'fs';

async function trainIncentiveModel() {
    // Training Data: [Visits, CommunityCamps, vaxCamps, Performance, BudgetIndex]
    const xs = tf.tensor2d([
        [10, 1, 1, 9, 1.0],  // Standard work
        [20, 2, 2, 10, 1.2], // High performer, high budget
        [5, 0, 0, 5, 0.8],  // Low work, low budget
        [30, 5, 3, 10, 1.0]  // Veteran worker
    ]);

    // Labels: Actual Payouts (Target output the AI should learn)
    const ys = tf.tensor2d([
        [2300], // (10*150 + 1*500 + 1*300) * 1.0
        [5160], // (20*150 + 2*500 + 2*300) * 1.2 budget multiplier
        [750],  // Lowered based on performance/budget
        [8900]
    ]);

    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 1, inputShape: [5] }));
    model.compile({ loss: 'meanSquaredError', optimizer: 'adam' });

    console.log("Training Incentive Agent...");
    await model.fit(xs, ys, { epochs: 500 });

    const modelPath = './incentive_agent_model';
    if (!fs.existsSync(modelPath)) fs.mkdirSync(modelPath);
    await model.save(`file://${modelPath}`);
    console.log("✅ Incentive Agent Model Trained and Saved!");
}

trainIncentiveModel();