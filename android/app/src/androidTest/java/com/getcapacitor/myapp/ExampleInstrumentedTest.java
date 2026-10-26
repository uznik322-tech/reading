package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Проверка контекста установленного приложения на Android-устройстве.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() throws Exception {
        // Контекст проверяемого приложения.
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("tech.uznik322.reading", appContext.getPackageName());
    }
}
